import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {pool,base} from './client.js';
import {cycle} from '../../src/represented/representative.js';
const path=readFileSync('.stage/latest-judgment.txt','utf8'),j=JSON.parse(readFileSync(path+'/results.json','utf8'));
try{
 const pair=j.results.find((x:any)=>x.outcome==='MUTUAL_AFFINITY');assert.ok(pair,'No real-model affinity in the saved diagnostic');
 const actorIds=pair.recommendations.map((x:any)=>x.participant_id);
 const row=(await pool.query("select rendezvous_id,participant_a,participant_b from rendezvous where participant_a=any($1) and participant_b=any($1) and outcome='MUTUAL_AFFINITY' limit 1",[actorIds])).rows[0];assert.ok(row,'No real-model affinity available for hosted completion');
 const ids=(await pool.query('select interview_id,email from interviews where network_participant_id=any($1)',[[row.participant_a,row.participant_b]])).rows;
 // Give this fixture immediate eligibility for a scheduler batch. Selection/delivery use the real cycle.
 await pool.query('update interviews set last_cycle_at=null,paid_at=now()-interval \'100 days\' where interview_id=any($1)',[ids.map((x:any)=>x.interview_id)]);
 await cycle();
 const links:string[]=[];
 for(const iv of ids){const mail=(await pool.query("select body from captured_mail where recipient=$1 and kind='briefing' order by mail_id desc limit 1",[iv.email])).rows[0];assert.ok(mail,'Briefing was not captured');const url=mail.body.match(/http:\/\/127\.0\.0\.1:18080\/introduction\/ic_[A-Za-z0-9_-]+/)?.[0];assert.ok(url);links.push(url);assert.equal((await fetch(url)).status,200);}
 for(let n=0;n<links.length;n++){
  const response=await fetch(links[n],{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({action:'yes',contact:'synthetic-'+n+'@example.invalid'})});assert.equal(response.status,200);if(n===0)assert.ok(!(await response.text()).includes('synthetic-1@example.invalid'));
 }
 const intro=(await pool.query('select state from introductions where rendezvous_id=$1',[row.rendezvous_id])).rows[0];assert.equal(intro.state,'REVEALED');
 await pool.query('update interviews set last_cycle_at=null,paid_at=now()-interval \'100 days\' where interview_id=any($1)',[ids.map((x:any)=>x.interview_id)]);await cycle();
 for(const iv of ids)assert.ok((await pool.query("select 1 from captured_mail where recipient=$1 and kind='reveal'",[iv.email])).rowCount);
 writeFileSync('.stage/hosted-introduction.json',JSON.stringify({passed:true,real_model_affinity:true,real_model_briefings:true,human_consent:'scripted yes from each fictional human via HTML form',state:intro.state,captured_reveal_emails:2,external_mail_sent:0},null,2));console.log('Real-model affinity → model briefings → captured links → both HTML consents → captured contact reveals: PASS');
}catch(e){writeFileSync('.stage/hosted-introduction.json',JSON.stringify({passed:false,error:String(e)},null,2));throw e;}finally{await pool.end();}
