import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { rpc, pool } from './client.js';
import { withTx } from '../../src/db/pool.js';
import { applyEvent } from '../../src/billing/stripe.js';
import { normalizeIntent, mutuallyEligible } from '../../src/discovery/eligibility.js';
import { sweepExpired } from '../../src/rendezvous/service.js';
import { sweepIntroductions } from '../../src/rendezvous/introductions.js';
const N=Number(process.env.CAMPAIGN_PEOPLE ?? 200), DAYS=30, seed=20260905;
const run='community-'+Date.now(), output='.stage/'+run;mkdirSync(output,{recursive:true});
let rng=seed;const random=()=>{rng=(Math.imul(rng,1664525)+1013904223)>>>0;return rng/4294967296;};
type Person={n:number,id:string,secret:string,region:string,intent:any,topic:string,period:number,joinDay:number,paid:boolean,left:boolean,consent:boolean,patience:number,events:any[],eligible:number};
const people:Person[]=[], byId=new Map<string,Person>(), timelines:any[]=[], work=new Map<string,{a:Person,b:Person,turn:number,opened:number}>();
const errors:any[]=[], daily:any[]=[], outcomes:any[]=[], gates={eligibility:0,unauthorized_reads:0,premature_contact:0};
function event(p:Person,day:number,kind:string,detail:any={}) {p.events.push({day,kind,...detail});timelines.push({person:p.n,day,kind,...detail});}
async function call(p:Person,tool:string,args:any={},allow=false){return rpc(tool,{participant_secret:p.secret,...args},allow);}
async function member(p:Person,day:number){
 await applyEvent({id:run+'-subscription-'+p.n,type:'customer.subscription.updated',data:{object:{id:'sub_fixture_'+run+'_'+p.n,status:'active',metadata:{participant_id:p.id},items:{data:[]}}}} as any);
 p.paid=true;event(p,day,'fixture_membership');
}
const started=Date.now();
try {
 for(let n=0;n<N;n++){
  const region=n<N*.5?'Dense':n<N*.8?'Sparse':'Unbalanced';
  const gender=region==='Unbalanced'?(n%5===0?'woman':'man'):(n%2?'woman':'man');
  const age=region==='Sparse'?[25,35,45,55,65][Math.floor(n/2)%5]:[35,40,45][Math.floor(n/2)%3];
  const intent={represented_gender:gender,seeking_gender:[gender==='man'?'woman':'man'],represented_age_band:age+'-'+(age+4),preferred_age_min:age-5,preferred_age_max:age+9,relationship_intent:['long_term'],region:run+' '+region};
  const p:Person={n,id:'',secret:'',region,intent,topic:['separate homes','shared home soon','flexible living'][Math.floor(random()*3)],period:1+Math.floor(random()*4),joinDay:n>=N*.85?8:0,paid:false,left:false,consent:random()>.2,patience:10+Math.floor(random()*20),events:[],eligible:0};people.push(p);
 }
 for(const p of people) p.eligible=people.filter(q=>q!==p && mutuallyEligible(normalizeIntent(p.intent),normalizeIntent(q.intent))).length;
 for(let day=0;day<DAYS;day++){
  // Logical time fixture, restricted to this run's IDs. This is not a wall-clock soak test.
  const ids=people.filter(p=>p.id).map(p=>p.id);
  if(day && ids.length){
   await pool.query("update participants set created_at=created_at-interval '1 day' where participant_id=any($1)",[ids]);
   await withTx(async tx => {
    const moved=await tx.query("delete from participant_activity_days where participant_id=any($1) returning participant_id,day::text",[ids]);
    await tx.query("insert into participant_activity_days(participant_id,day) select participant_id,day::date-1 from jsonb_to_recordset($1::jsonb) as x(participant_id text,day text)",[JSON.stringify(moved.rows)]);
   });
   await pool.query("update audit_log set created_at = created_at - interval '1 day' where participant_id = any($1)",[ids]);
   await pool.query("update rendezvous set updated_at = updated_at - interval '1 day', invitation_expires_at = invitation_expires_at - interval '1 day' where participant_a = any($1)",[ids]);
   await pool.query("update introductions set expires_at = expires_at - interval '1 day' where rendezvous_id in (select rendezvous_id from rendezvous where participant_a = any($1))",[ids]);
   await sweepExpired();await sweepIntroductions();
  }
  for(const p of people.filter(p=>p.joinDay===day)){
   const j=await rpc('join',{intent:p.intent,client:{name:run}});p.id=j.participant_id;p.secret=j.participant_secret;byId.set(p.id,p);event(p,day,'joined');
   if(p.n%4!==0)await member(p,day);
  }
  // Each person has an independent response schedule. Non-paying people may buy after invitation or decline.
  for(const p of people.filter(p=>p.id&&!p.left&&day%p.period===0)){
   try {
    const st=await call(p,'status');
    if(day>=p.patience && !p.events.some(e=>e.kind==='introduced')){await call(p,'withdraw',{reason:'synthetic patience threshold'});p.left=true;event(p,day,'withdrew');continue;}
    for(const inv of st.invitations ?? []) { if(p.n%8===0){await call(p,'rendezvous_close',{rendezvous_id:inv.rendezvous_id});event(p,day,'invitation_declined');} else if(!p.paid)await member(p,day); }
    if(!p.paid)continue;
    for(const r of [...(st.rendezvous ?? []), ...(st.invitations ?? []).filter((i:any)=>p.n%8!==0).map((i:any)=>({...i,action_needed:"respond"}))]){
     const w=work.get(r.rendezvous_id);if(!w||r.action_needed==='wait')continue;
     const read=await call(p,'rendezvous_read',{rendezvous_id:r.rendezvous_id});
     if(read.state!=='OPEN'||read.recommendation.yours_submitted)continue;
     if(read.messages_from_you>=3 && read.messages_from_counterparty>=3){
      const otherMessages=read.messages.filter((m:any)=>m.from==='counterparty').map((m:any)=>m.message).join(' ');
      // Scripted screening reads disclosed messages; it never reads the other person's private dossier.
      const incompatible=p.topic==='separate homes'&&otherMessages.includes('shared home soon') || p.topic==='shared home soon'&&otherMessages.includes('separate homes');
      const rec=await call(p,'recommend',{rendezvous_id:r.rendezvous_id,recommend:!incompatible,concerns:[incompatible?'Different non-negotiable living arrangements':'In-person attraction remains unknown'],strengths:incompatible?[]:['Living expectations were discussed']});
      event(p,day,'recommended',{rendezvous:r.rendezvous_id,yes:!incompatible});
      if(rec.status!=='AWAITING_COUNTERPARTY'){outcomes.push({day,rendezvous:r.rendezvous_id,outcome:rec.status,a:w.a.n,b:w.b.n});event(w.a,day,rec.status,{rendezvous:r.rendezvous_id});event(w.b,day,rec.status,{rendezvous:r.rendezvous_id});}
     } else if(!read.recommendation.yours_submitted){
      const content=`My client says their living preference is ${p.topic}. This is explicit. ${['What living arrangement does your client need?','Would either person need to compromise a firm boundary?','What important uncertainty remains before meeting?'][Math.min(read.messages_from_you,2)]}`;
      const sent=await call(p,'rendezvous_send',{rendezvous_id:r.rendezvous_id,message:content,claims:[{claim:'Living preference: '+p.topic,basis:'EXPLICIT'}]},true);if(sent.error==='RATE_LIMITED'){event(p,day,'capacity_wait',{rendezvous:r.rendezvous_id});continue;}if(sent.error)throw new Error(JSON.stringify(sent));event(p,day,'message',{rendezvous:r.rendezvous_id,text:content});
     }
    }
    for(const a of st.mutual_affinities??[]){
     if(a.introduction?.state==='REVEALED'&&!p.events.some(e=>e.kind==='introduced'&&e.rendezvous===a.rendezvous_id)){event(p,day,'introduced',{rendezvous:a.rendezvous_id});}
     if(a.introduction?.state==='AWAITING_BOTH'&&a.introduction.your_consent==='PENDING'){
      const before=await call(p,'introduction',{rendezvous_id:a.rendezvous_id,action:'status'});if(before.counterparty_contact)gates.premature_contact++;
      // A declared synthetic human decision, independent from the agent recommendation.
      const answer=await call(p,'introduction',{rendezvous_id:a.rendezvous_id,action:p.consent?'accept':'decline',human_confirmed:true,contact:'person'+p.n+'@example.invalid'});
      event(p,day,'human_decision',{rendezvous:a.rendezvous_id,yes:p.consent,state:answer.state});
     }
    }
    if((st.open_rendezvous??0)<2 && day<22){
     const d=await call(p,'discover',{limit:3});
     const candidates=(d.candidates??[]).filter((c:any)=>byId.has(c.candidate_id));
     for(const c of candidates){const q=byId.get(c.candidate_id)!;if(!mutuallyEligible(normalizeIntent(p.intent),normalizeIntent(q.intent)))gates.eligibility++;}
     if(candidates.length){
      const c=candidates[Math.floor(random()*candidates.length)],q=byId.get(c.candidate_id)!;
      const opened=await call(p,'rendezvous_open',{candidate_id:c.candidate_id,message:'My client wants a lasting relationship. Their living preference is '+p.topic+'. What does your client need?'},true);
      if(!opened.error&&!opened.existing){work.set(opened.rendezvous_id,{a:p,b:q,turn:0,opened:day});event(p,day,'opened',{rendezvous:opened.rendezvous_id,other:q.n});}
      else if(opened.error && !['RATE_LIMITED','CONFLICT'].includes(opened.error))errors.push({day,person:p.n,error:opened.error});
     } else event(p,day,'no_available_candidates');
    }
   }catch(e){errors.push({day,person:p.n,error:String(e)});}
  }
  daily.push({day,joined:people.filter(p=>p.id).length,members:people.filter(p=>p.paid&&!p.left).length,opened:work.size,concluded:outcomes.length,affinities:outcomes.filter(o=>o.outcome==='MUTUAL_AFFINITY').length,introduced:people.filter(p=>p.events.some(e=>e.kind==='introduced')).length,withdrawn:people.filter(p=>p.left).length});
  writeFileSync(output+'/progress.json',JSON.stringify({run,population:N,daily,errors}));
  console.log(JSON.stringify(daily.at(-1)));
 }
 const ids=people.filter(p=>p.id).map(p=>p.id);
 const contacts=(await pool.query("select count(*)::int as n from introductions i join rendezvous r using(rendezvous_id) where r.participant_a = any($1) and i.state in ('DECLINED','EXPIRED') and (i.a_contact is not null or i.b_contact is not null)",[ids])).rows[0].n;
 const anyWork=work.keys().next().value;if(anyWork){const w=work.get(anyWork)!;const outsider=people.find(p=>p.id&&p!==w.a&&p!==w.b&&!p.left);if(outsider){const r=await call(outsider,'rendezvous_read',{rendezvous_id:anyWork},true);if(!r.error)gates.unauthorized_reads++;}}
 const established=(await pool.query("select count(*)::int as n from participants p where p.participant_id=any($1) and (select count(*) from participant_activity_days d where d.participant_id=p.participant_id)>=5 and (select count(*) from rendezvous r where (r.participant_a=p.participant_id or r.participant_b=p.participant_id) and r.state='CLOSED' and r.outcome in ('MUTUAL_AFFINITY','NO_INTRODUCTION','DECLINED') and r.message_count>=2)>=3",[ids])).rows[0].n;
 const result={run,seed,established_participants:established,population:N,days:DAYS,elapsed_ms:Date.now()-started,method:'Scripted people and representatives on real MCP. Synthetic subscription events, not Stripe transactions. 30 logical days with isolated DB aging, not a real-time soak. Server candidate order includes unseeded randomness; event log is authoritative replay.',daily,outcomes,errors,gates:{...gates,retained_terminal_contacts:contacts},people:people.map(({secret,...p})=>({...p,intent:undefined})),timelines,regions:['Dense','Sparse','Unbalanced'].map(region=>{const p=people.filter(x=>x.region===region);return{region,people:p.length,mean_eligible:p.reduce((n,x)=>n+x.eligible,0)/p.length,no_opportunity:p.filter(x=>!x.events.some(e=>e.kind==='opened'||e.kind==='message')).length,introduced:p.filter(x=>x.events.some(e=>e.kind==='introduced')).length,withdrew:p.filter(x=>x.left).length};})};
 writeFileSync(output+'/results.json',JSON.stringify(result,null,2));writeFileSync('.stage/latest-community.txt',output);console.log('RESULTS '+output);
 assert.equal(contacts,0);assert.ok(Object.values(gates).every(n=>n===0));assert.equal(errors.length,0,'unexpected campaign errors');
}finally{await pool.end();}
