import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { rpc, pool, admin, http } from './client.js';
import { cycle, decideIntroduction } from '../../src/represented/representative.js';
import { sharedFacts } from '../../src/represented/sharing.js';
import { sweepIntroductions } from '../../src/rendezvous/introductions.js';
import { applyEvent } from '../../src/billing/stripe.js';
import { exclusive } from '../../src/db/lock.js';
const run='readiness-'+Date.now(), checks:any[]=[];
async function check(name:string,fn:()=>Promise<void>){try{await fn();checks.push({name,passed:true});console.log('PASS '+name);}catch(e){checks.push({name,passed:false,error:String(e)});console.log('FAIL '+name+': '+e);}}
const intent=(gender:string)=>({represented_gender:gender,seeking_gender:[gender==='man'?'woman':'man'],represented_age_band:'40-44',relationship_intent:['long_term'],region:run});
async function join(gender:string,name=run){const p=await rpc('join',{intent:intent(gender),client:{name}});await admin('/participants/'+p.participant_id+'/membership',{action:'grant'});return p;}
const call=(p:any,t:string,a:any={},allow=false)=>rpc(t,{participant_secret:p.participant_secret,...a},allow);
async function affinity(a:any,b:any){const r=await call(a,'rendezvous_open',{candidate_id:b.participant_id});for(let i=0;i<3;i++)for(const p of [a,b])await call(p,'rendezvous_send',{rendezvous_id:r.rendezvous_id,message:'We want a lasting relationship and value independent time. What uncertainty should we explore?'});for(const p of [a,b])await call(p,'recommend',{rendezvous_id:r.rendezvous_id,recommend:true,concerns:['In-person chemistry unknown']});return r.rendezvous_id;}
async function scheduledCycleFor(id:string) {
 const before=(await pool.query('select last_cycle_at from interviews where interview_id=$1',[id])).rows[0].last_cycle_at;
 for(let i=0;i<20;i++){await cycle();const after=(await pool.query('select last_cycle_at from interviews where interview_id=$1',[id])).rows[0].last_cycle_at;if(after && (!before || new Date(after).getTime()>new Date(before).getTime()))return;}
 throw new Error('Hosted person was starved after twenty scheduler batches');
}
const token=()=> 'iv_'+randomBytes(24).toString('base64url'),hash=(s:string)=>createHash('sha256').update(s).digest('hex');
async function hosted(p:any){const t=token(),id='iv_'+randomBytes(12).toString('hex');await pool.query("insert into interviews(interview_id,email,token_hash,status,expires_at,intent_json,network_participant_id,network_secret,paid_at,dossier_json) values ($1,$2,$3,'paid',now()+interval '14 days',$4,$5,$6,now(),$7)",[id,run+'@example.invalid',hash(t),JSON.stringify(intent('woman')),p.participant_id,p.participant_secret,JSON.stringify({facts:[{topic:'lifestyle',fact:'Enjoys walking',provenance:'EXPLICIT',share:false},{topic:'private',fact:'PRIVATE_CANARY_'+id,provenance:'EXPLICIT',share:false}]})]);return {id,t};}
try{
 const a=await join('man'),b=await join('woman','rendezvous-representative'),outsider=await join('man');const h=await hosted(b);
 await check('Impersonation denied; actual hosted relationship recognised',async()=>{
  const fake=await join('woman','rendezvous-representative');const d=await call(a,'discover',{limit:10});assert.equal(d.candidates.find((c:any)=>c.candidate_id===fake.participant_id).represented,false);assert.equal(d.candidates.find((c:any)=>c.candidate_id===b.participant_id).represented,true);
 });
 await check('Human sharing selection is enforced; private canary excluded',async()=>{
  assert.deepEqual(sharedFacts([{fact:'secret',share:false}]),[]);const result=await http('/interview/'+h.t+'/sharing',{facts:[0]});assert.equal(result.status,200);const d=(await pool.query('select dossier_json from interviews where interview_id=$1',[h.id])).rows[0];assert.equal(sharedFacts(d.dossier_json.facts).length,1);assert.ok(!JSON.stringify(sharedFacts(d.dossier_json.facts)).includes('PRIVATE_CANARY'));
  assert.equal((await http('/interview/'+h.t+'/sharing',{facts:[999]})).status,400);
 });
 const rv=await affinity(a,b),ct='ic_'+randomBytes(24).toString('base64url'),bf='bf_'+randomBytes(12).toString('hex');
 await pool.query('insert into briefings(briefing_id,interview_id,rendezvous_id,body,token_hash) values($1,$2,$3,$4,$5)',[bf,h.id,rv,'A synthetic briefing about shared lifestyle.',hash(ct)]);
 await check('Cross-participant transcript read and consent rejected',async()=>{assert.ok((await call(outsider,'rendezvous_read',{rendezvous_id:rv},true)).error);assert.ok((await call(outsider,'introduction',{rendezvous_id:rv,action:'accept',human_confirmed:true,contact:'outsider@example.invalid'},true)).error);});
 await check('Failed briefing mail retries and produces a captured consent link',async()=>{
  await pool.query("insert into settings(key,value) values('stage_mail_failure','true') on conflict(key) do update set value='true'");await scheduledCycleFor(h.id);assert.equal((await pool.query('select mail_sent_at from briefings where briefing_id=$1',[bf])).rows[0].mail_sent_at,null);
  await pool.query("update settings set value='false' where key='stage_mail_failure'");await scheduledCycleFor(h.id);assert.ok((await pool.query('select mail_sent_at from briefings where briefing_id=$1',[bf])).rows[0].mail_sent_at);assert.ok((await pool.query("select body from captured_mail where kind='briefing' and recipient=$1",[run+'@example.invalid'])).rows.some((r:any)=>r.body.includes('/introduction/ic_')));
 });
 await check('One YES reveals nothing; decline deletes hosted and network contacts',async()=>{
  await call(b,'introduction',{rendezvous_id:rv,action:'accept',human_confirmed:true,contact:'hidden@example.invalid'});await pool.query("update briefings set consent_state='YES',contact_shared='hidden@example.invalid' where briefing_id=$1",[bf]);const status=await call(a,'introduction',{rendezvous_id:rv,action:'status'});assert.equal(status.counterparty_contact,undefined);await call(a,'introduction',{rendezvous_id:rv,action:'decline'});
  const local=(await pool.query('select * from briefings where briefing_id=$1',[bf])).rows[0];assert.equal(local.contact_shared,null);assert.equal(local.consent_state,'CLOSED');
  const net=(await pool.query('select * from introductions where rendezvous_id=$1',[rv])).rows[0];assert.equal(net.a_contact,null);assert.equal(net.b_contact,null);
 });
 await check('Failed outcome mail is retried, then marked sent',async()=>{await pool.query("update settings set value='true' where key='stage_mail_failure'");await scheduledCycleFor(h.id);assert.equal((await pool.query('select outcome_sent_at from briefings where briefing_id=$1',[bf])).rows[0].outcome_sent_at,null);await pool.query("update settings set value='false' where key='stage_mail_failure'");await scheduledCycleFor(h.id);assert.ok((await pool.query('select outcome_sent_at from briefings where briefing_id=$1',[bf])).rows[0].outcome_sent_at);});
 await check('Expiry deletes held contacts without a representative cycle',async()=>{
  const x=await join('man'),y=await join('woman'),hy=await hosted(y),id=await affinity(x,y);await call(y,'introduction',{rendezvous_id:id,action:'accept',human_confirmed:true,contact:'expires@example.invalid'});await pool.query("insert into briefings(briefing_id,interview_id,rendezvous_id,body,token_hash,consent_state,contact_shared) values($1,$2,$3,'expire',$4,'YES','expires@example.invalid')",['bf_'+randomBytes(12).toString('hex'),hy.id,id,hash(token())]);await pool.query("update introductions set expires_at=now()-interval '1 second' where rendezvous_id=$1",[id]);await sweepIntroductions();assert.equal((await pool.query('select contact_shared from briefings where rendezvous_id=$1',[id])).rows[0].contact_shared,null);
 });
 await check('Database execution lock excludes overlapping work',async()=>{
  let release!:()=>void;const hold=new Promise<void>(r=>release=r);let acquired!:()=>void;const ready=new Promise<void>(r=>acquired=r);const first=exclusive(run,async()=>{acquired();await hold;return 1;});await ready;assert.equal(await exclusive(run,async()=>2),null);release();assert.equal(await first,1);assert.equal(await exclusive(run,async()=>3),3);
 });
 await check('Duplicate synthetic payment event applies once',async()=>{const e:any={id:run+'-payment',type:'customer.subscription.updated',data:{object:{id:'sub_fixture',status:'active',metadata:{participant_id:a.participant_id},items:{data:[]}}}};assert.equal((await applyEvent(e)).applied,true);assert.equal((await applyEvent(e)).duplicate,true);});
 await check('Unpaid one-time checkout cannot activate hosted representation',async()=>{
  const iv='iv_'+randomBytes(12).toString('hex');await pool.query("insert into interviews(interview_id,email,token_hash,status,expires_at) values($1,'unpaid@example.invalid',$2,'complete',now()+interval '1 day')",[iv,hash(token())]);
  const e:any={id:run+'-unpaid',type:'checkout.session.completed',data:{object:{mode:'payment',payment_status:'unpaid',metadata:{interview_id:iv}}}};
  assert.equal((await applyEvent(e)).applied,false);assert.equal((await pool.query('select status from interviews where interview_id=$1',[iv])).rows[0].status,'complete');
 });
 await check('Concurrent duplicate opens return one rendezvous without internal errors',async()=>{
  const x=await join('man'),y=await join('woman');const results=await Promise.all(Array.from({length:6},()=>call(x,'rendezvous_open',{candidate_id:y.participant_id},true)));
  assert.ok(results.every(r=>!r.error),JSON.stringify(results));assert.equal(new Set(results.map(r=>r.rendezvous_id)).size,1);
  await call(x,'rendezvous_close',{rendezvous_id:results[0].rendezvous_id});
 });
 await check('Later hosted customers receive scheduler service beyond first 25',async()=>{
  const ids:string[]=[];for(let i=0;i<27;i++){const p=await join('woman');ids.push((await hosted(p)).id);}for(let n=0;n<8;n++){await cycle();const remaining=await pool.query('select count(*)::int as n from interviews where interview_id=any($1) and last_cycle_at is null',[ids]);if(!remaining.rows[0].n)break;}const rows=await pool.query('select count(*)::int as n from interviews where interview_id=any($1) and last_cycle_at is not null',[ids]);assert.equal(rows.rows[0].n,27);
 });
}finally{await pool.query("update settings set value='false' where key='stage_mail_failure'").catch(()=>{});writeFileSync('.stage/readiness.json',JSON.stringify({run,checks,method:'Real local service, synthetic fixtures, captured mail. Payment test uses internal event fixture, not a provider transaction.'},null,2));await pool.end();}
assert.ok(checks.every(c=>c.passed),'readiness gate failed');
