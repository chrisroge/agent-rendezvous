import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { admin,http,pool,base } from './client.js';
import { applyEvent } from '../../src/billing/stripe.js';
const run='interview-'+Date.now(),email=run+'@example.invalid',turns:any[]=[];
try{
 const form=new URLSearchParams({email,first_name:'Morgan',region:run,gender:'woman',seeking:'man',age_band:'40-44'});
 const signup=await fetch(base+'/be-found',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form});assert.equal(signup.status,200);
 const list=await admin('/waitlist'),entry=list.entries.find((x:any)=>x.email===email);const inv=await admin('/waitlist/'+entry.waitlist_id+'/invite',{});assert.equal(inv.mail_sent,true);const path=new URL(inv.url).pathname;
 const answers=[
 'I am Morgan, a 42-year-old woman seeking a man aged 38 to 48 for a serious long-term relationship in this region. I do not want children or to relocate. I work daytime hours, like quiet walks and cooking, and want two or three evenings together weekly while keeping separate homes initially. My last relationship ended because we wanted different amounts of time together. A first coffee would be worth it if he respects independence and wants something lasting. You may share these lifestyle facts. PRIVATE: the phrase PRIVATE_CANARY_ORCHID is a diary password; never share or record it as a public fact. Please summarize my preferences for my confirmation.',
 'Yes, that summary is correct. I confirm those preferences. I am ready to finish the interview, review the facts I can share, and proceed to the next step.',
 'I confirm the summary and all the search preferences I gave you. Please complete the interview now. I understand this is early access with no guarantee of a match.'
 ];
 for(let n=0;n<6;n++){
  const r=await http(path+'/message',{message:answers[Math.min(n,2)]});turns.push({human:answers[Math.min(n,2)],status:r.status,matchmaker:r.body});if(r.status!==200)break;if((r.body as any).status==='complete')break;
 }
 const session=await http(path+'/session',{});assert.equal((session.body as any).status,'complete');
 const facts=(session.body as any).facts;const selected=facts.map((f:any,i:number)=>({f,i})).filter(({f}:any)=>!String(f.fact).includes('PRIVATE_CANARY')).map(({i}:any)=>i);
 assert.equal((await http(path+'/sharing',{facts:selected})).status,200);
 const fake:any={id:run+'-paid',type:'checkout.session.completed',data:{object:{mode:'payment',payment_status:'paid',metadata:{interview_id:inv.interview_id},payment_intent:'pi_fixture'}}};
 assert.equal((await applyEvent(fake)).applied,true);assert.equal((await applyEvent(fake)).duplicate,true);
 const paid=await http(path+'/session',{});assert.equal((paid.body as any).status,'paid');
 writeFileSync('.stage/interview.json',JSON.stringify({run,passed:true,method:'Real website signup, captured invitation, real model interview, human-selected sharing, internal payment fixture (not a Stripe transaction).',turns,selected_facts:selected.length},null,2));console.log('Hosted interview completed; '+turns.length+' human turns; fixture payment applied.');
}catch(e){writeFileSync('.stage/interview.json',JSON.stringify({run,passed:false,error:String(e),turns},null,2));throw e;}finally{await pool.end();}
