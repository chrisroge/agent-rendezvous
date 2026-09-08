/** A small provider smoke test, never a load test. Run only with sandbox/test credentials. */
import Stripe from 'stripe';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { config } from '../../src/config.js';
import { rpc,pool,base } from './client.js';
if (!/^(sk|rk)_test_/.test(config.stripeSecretKey)) {
 writeFileSync('.stage/stripe.json',JSON.stringify({passed:false,blocked:true,reason:'A separate Stripe sandbox/test key is required; no provider transactions executed.'},null,2));
 await pool.end();throw new Error('Put the test key in rendezvous/staging/stripe, then run tools/stage.py again. Live credentials cannot be used.');
}
const stripe=new Stripe(config.stripeSecretKey),run='stage-'+Date.now();
if (process.argv.includes('--setup')) {
 const product=await stripe.products.create({name:'Rendezvous staging membership',metadata:{campaign:run}});
 const price=await stripe.prices.create({product:product.id,currency:'usd',unit_amount:3900,recurring:{interval:'month'}});
 const represented=await stripe.prices.create({product:product.id,currency:'usd',unit_amount:2900});
 const env=JSON.parse(readFileSync('.stage/env.json','utf8'));Object.assign(env,{STRIPE_PRICE_ID:price.id,STRIPE_REPRESENTED_PRICE_ID:represented.id,STRIPE_WEBHOOK_SECRET:'whsec_'+randomBytes(24).toString('hex')});writeFileSync('.stage/env.json',JSON.stringify(env));chmodSync('.stage/env.json',0o600);
 console.log('Sandbox prices and local forwarding signature configured. Restart the local stage, then run without --setup.');
 await pool.end();process.exit(0);
}
if(!config.stripeWebhookSecret||!config.stripePriceId)throw new Error('Run --setup and restart stage first');
let customer:string|undefined,sub:string|undefined;
try {
 const price=await stripe.prices.retrieve(config.stripePriceId);if(price.livemode)throw new Error('Refusing a live price');
 const p=await rpc('join',{intent:{represented_gender:'man',seeking_gender:['woman'],represented_age_band:'40-44',relationship_intent:['long_term'],region:run},client:{name:'stripe-sandbox-smoke'}});
 const c=await stripe.customers.create({name:'Synthetic staging customer',payment_method:'pm_card_visa',invoice_settings:{default_payment_method:'pm_card_visa'},metadata:{participant_id:p.participant_id}});customer=c.id;
 const s=await stripe.subscriptions.create({customer:c.id,items:[{price:price.id}],metadata:{participant_id:p.participant_id},expand:['latest_invoice']});sub=s.id;
 if(s.livemode||s.status!=='active')throw new Error('Sandbox subscription did not activate: '+s.status);
 await pool.query('update participants set stripe_customer_id=$2 where participant_id=$1',[p.participant_id,c.id]);
 // Relay a REAL provider event through the app's signature-verification route using a local forwarding secret.
 // This verifies the handler, not delivery from a public Stripe webhook endpoint.
 let event:Stripe.Event|undefined;
 for(let attempt=0;attempt<8&&!event;attempt++){
  const events=await stripe.events.list({type:'customer.subscription.created',limit:20});event=events.data.find(e=>(e.data.object as any).id===s.id);
  if(!event)await new Promise(r=>setTimeout(r,1000));
 }
 if(!event)throw new Error('Provider event unavailable');
 const payload=JSON.stringify(event),signature=stripe.webhooks.generateTestHeaderString({payload,secret:config.stripeWebhookSecret});
 const post=()=>fetch(base+'/webhooks/stripe',{method:'POST',headers:{'content-type':'application/json','stripe-signature':signature},body:payload});
 const first=await post(),firstBody:any=await first.json(),second=await post(),secondBody:any=await second.json();if(!first.ok||!firstBody.applied||!secondBody.duplicate)throw new Error('Webhook application or deduplication failed');
 const status=await rpc('billing',{participant_secret:p.participant_secret});if(!status.membership.active)throw new Error('Membership not activated');
 const canceled=await stripe.subscriptions.cancel(s.id);sub=undefined;
 writeFileSync('.stage/stripe.json',JSON.stringify({passed:true,live:false,subscription_status:s.status,canceled_status:canceled.status,invoice_paid:typeof s.latest_invoice==='object'&&s.latest_invoice?.status==='paid',real_provider_transaction:true,webhook_locally_forwarded:true,public_webhook_delivery_verified:false,duplicate_event_ignored:secondBody.duplicate},null,2));
 console.log('Sandbox subscription paid and canceled; real provider event applied and deduplicated through local signed forwarding. Public webhook delivery not tested.');
}finally{if(sub)await stripe.subscriptions.cancel(sub).catch(()=>{});if(customer)await stripe.customers.del(customer).catch(()=>{});await pool.end();}
