import { Router, type Request, type Response } from "express";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { authInterview, appendMessage, history, matchmakerName, type Interview } from "./service.js";
import { reply, interviewModelAvailable } from "./interview.js";
import { createRepresentedCheckout } from "../billing/stripe.js";
import { escape } from "../web/pages.js";

const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), component: "interview", ...o }));

function page(iv: Interview | null, paidFlag: boolean): string {
  const name = config.interview.matchmakerName;
  const title = name ? `Meet ${name}` : "Your matchmaker";
  const gone = !iv ? { h: "This link isn't valid.", p: "Interview links are private, single-use and expire after a while. If yours has, write to privacy@agentrendezvous.app and we'll send a fresh one." }
    : iv.status === "expired" ? { h: "This link has expired.", p: "No harm done — nothing was stored beyond what you'd already said. Write to privacy@agentrendezvous.app for a fresh one, or to be removed." }
    : iv.status === "closed" ? { h: "This interview is closed.", p: "If that's a surprise, write to privacy@agentrendezvous.app." } : null;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${escape(title)} — Rendezvous</title>
<link rel="preload" href="/static/fraunces-normal.woff2" as="font" type="font/woff2" crossorigin>
<style>
@font-face{font-family:"Fraunces";font-style:normal;font-weight:400 700;font-display:swap;src:url(/static/fraunces-normal.woff2) format("woff2")}
:root{--base:#faf4ed;--surface:#fffaf3;--line:#dfdad9;--text:#575279;--ink:#453f63;--found:#b4637a;--soft:rgba(180,99,122,.11);--on:#fffaf3}
@media (prefers-color-scheme:dark){:root{--base:#191724;--surface:#1f1d2e;--line:#403d52;--text:#e0def4;--ink:#e0def4;--found:#eb6f92;--soft:rgba(235,111,146,.14);--on:#191724}}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(60% 40% at 90% -5%,var(--soft),transparent 65%),var(--base);color:var(--text);font:16.5px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;display:flex;flex-direction:column;min-height:100dvh}
header{padding:22px 20px 8px;text-align:center}h1{font-family:"Fraunces",Georgia,serif;font-weight:500;font-size:32px;letter-spacing:-.02em;color:var(--ink);margin:0}h1 span{color:var(--found)}
.sub{font-size:13.5px;opacity:.75;margin:6px 0 0}
#chat{flex:1;overflow-y:auto;max-width:680px;width:100%;margin:0 auto;padding:14px 18px 8px;display:flex;flex-direction:column;gap:10px}
.m{max-width:84%;padding:11px 15px;border-radius:18px;white-space:pre-wrap}.mm{background:var(--surface);border:1px solid var(--line);border-bottom-left-radius:6px;align-self:flex-start}.me{background:var(--found);color:var(--on);border-bottom-right-radius:6px;align-self:flex-end}
.sys{align-self:center;font-size:13px;opacity:.7;text-align:center;max-width:90%}
.done{align-self:center;background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:18px 20px;max-width:90%;text-align:center}.done b{display:block;color:var(--ink);font-size:18px;margin-bottom:6px}
form{display:flex;gap:10px;max-width:680px;width:100%;margin:0 auto;padding:10px 18px 20px}textarea{flex:1;resize:none;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:14px;padding:11px 14px;font:inherit;min-height:46px;max-height:140px}
button{border:0;background:var(--found);color:var(--on);border-radius:999px;padding:12px 22px;font:inherit;font-weight:650;cursor:pointer}button:disabled{opacity:.5}
.gone{max-width:560px;margin:60px auto;padding:0 22px;text-align:center}.gone h2{font-family:"Fraunces",Georgia,serif;font-weight:500;color:var(--ink);font-size:28px}
a{color:var(--found)}
</style></head><body>
<header><h1>${name ? `Meet <span>${escape(name)}</span>` : `Your <span>matchmaker</span>`}</h1><p class="sub">One conversation. Then go live your life.</p></header>
${gone ? `<div class="gone"><h2>${escape(gone.h)}</h2><p>${escape(gone.p)}</p><p><a href="/">agentrendezvous.app</a></p></div>` : `
<div id="chat"></div>
<form id="f"><textarea id="t" placeholder="Write to ${escape(name || "your matchmaker")}…" rows="1"></textarea><button id="b" type="submit">Send</button></form>
<script>
const BASE=location.pathname.replace(/\\/+$/,'');const PAID=${paidFlag ? "true" : "false"};
const chat=document.getElementById('chat'),f=document.getElementById('f'),t=document.getElementById('t'),b=document.getElementById('b');
function add(role,text){const d=document.createElement('div');d.className='m '+(role==='matchmaker'?'mm':role==='client'?'me':'sys');d.textContent=text;chat.appendChild(d);chat.scrollTop=chat.scrollHeight;return d;}
function done(status){const old=document.getElementById('done');if(old)old.remove();if(status!=='complete'&&status!=='paid')return;const d=document.createElement('div');d.id='done';d.className='done';
 if(status==='paid'){d.innerHTML='<b>You\\'re represented.</b>Nothing more to do. You\\'ll hear from us only when two independent sides agree someone is worth an hour of your time — and then you decide.';}
 else{d.innerHTML='<b>The interview is complete.</b>To be represented on the network: <span id="price"></span>, once — never again, refundable if we never bring you anyone.<br><br><button id="pay" type="button">Represent me</button><br><small>Or keep talking — updates are welcome any time.</small>';}
 chat.appendChild(d);chat.scrollTop=chat.scrollHeight;
 const pay=document.getElementById('pay');if(pay)pay.onclick=async()=>{pay.disabled=true;try{const r=await api('/checkout',{});location.href=r.url;}catch(e){add('sys',e.message);pay.disabled=false;}};
}
async function api(p,body){const r=await fetch(BASE+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});if(!r.ok){const e=await r.json().catch(()=>({error:'Something went sideways.'}));throw new Error(e.error||('HTTP '+r.status));}return r.json();}
(async()=>{try{const s=await api('/session');for(const m of s.history)add(m.role,m.content);const p=document.getElementById('price');done(s.status);const pr=document.getElementById('price');if(pr)pr.textContent=s.price;if(PAID&&s.status!=='paid')add('sys','Payment received — confirming…');}catch(e){add('sys','Could not load the conversation: '+e.message);}})();
f.addEventListener('submit',async(ev)=>{ev.preventDefault();const msg=t.value.trim();if(!msg)return;add('client',msg);t.value='';b.disabled=true;const w=add('sys','…');
 try{const r=await api('/message',{message:msg});w.remove();add('matchmaker',r.reply);done(r.status);const pr=document.getElementById('price');if(pr)pr.textContent=r.price;}catch(e){w.remove();add('sys',e.message);}finally{b.disabled=false;t.focus();}});
t.addEventListener('keydown',(e)=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();f.requestSubmit();}});
</script>`}
</body></html>`;
}

const price = () => `$${config.pricing.chosenOneTimeUsd}`;

/** Mounted at /interview. Every route is keyed by the single-use token in the path; no cookies, no accounts. */
export function interviewRouter(): Router {
  const r = Router();
  r.get("/:token", async (req, res) => {
    const iv = await authInterview(String(req.params.token));
    res.type("html").send(page(iv, req.query.paid === "1"));
  });
  r.post("/:token/session", async (req, res) => {
    const iv = await authInterview(String(req.params.token));
    if (!iv || iv.status === "expired" || iv.status === "closed") { res.status(404).json({ error: "This link isn't valid any more." }); return; }
    res.json({ status: iv.status, first_name: iv.first_name, matchmaker: matchmakerName(), price: price(), history: await history(iv.interview_id) });
  });
  r.post("/:token/message", async (req, res) => {
    const iv = await authInterview(String(req.params.token));
    if (!iv || iv.status === "expired" || iv.status === "closed") { res.status(404).json({ error: "This link isn't valid any more." }); return; }
    const msg = String(req.body?.message ?? "").trim();
    if (!msg || msg.length > 4000) { res.status(400).json({ error: "Say it in 1–4000 characters." }); return; }
    if (!interviewModelAvailable()) { res.status(503).json({ error: "The matchmaker is away right now. Your link stays valid — try again later." }); return; }
    if (iv.client_turns >= config.interview.maxTurns && iv.status !== "paid") { res.status(429).json({ error: "That's a full interview already — thank you. If there's something important left, write to privacy@agentrendezvous.app." }); return; }
    const hour = await pool.query("select count(*)::int as n from interview_messages where interview_id = $1 and role = 'client' and created_at > now() - interval '1 hour'", [iv.interview_id]);
    if (hour.rows[0].n >= 30) { res.status(429).json({ error: "Let's take a breath — come back in a little while." }); return; }
    const today = await pool.query("select count(*)::int as n from interview_messages where role = 'client' and created_at > now() - interval '1 day'");
    if (today.rows[0].n >= config.interview.dailyTurnCap) { res.status(503).json({ error: "The matchmaker is fully booked today — please come back tomorrow. Your link stays valid." }); return; }
    await appendMessage(iv.interview_id, "client", msg);
    await pool.query("update interviews set client_turns = client_turns + 1, status = case when status = 'invited' then 'in_progress' else status end, started_at = coalesce(started_at, now()) where interview_id = $1", [iv.interview_id]);
    try {
      const out = await reply(iv, msg);
      await appendMessage(iv.interview_id, "matchmaker", out);
      const st = await pool.query("select status from interviews where interview_id = $1", [iv.interview_id]);
      res.json({ reply: out, status: st.rows[0].status, price: price() });
    } catch (e) {
      log({ level: "error", msg: "interview reply failed", error: (e as Error).message });
      res.status(502).json({ error: "Your matchmaker lost the thread for a moment — say that again?" });
    }
  });
  r.post("/:token/checkout", async (req, res) => {
    const iv = await authInterview(String(req.params.token));
    if (!iv) { res.status(404).json({ error: "This link isn't valid any more." }); return; }
    if (iv.status === "paid") { res.json({ url: `${config.publicUrl}/interview/${req.params.token}?paid=1`, already: true }); return; }
    if (iv.status !== "complete") { res.status(409).json({ error: "Finish the interview first — your matchmaker will tell you when it's complete." }); return; }
    try { res.json(await createRepresentedCheckout(iv.interview_id, String(req.params.token))); }
    catch (e) { res.status(503).json({ error: (e as any).message ?? "Payment isn't available right now. Your interview is saved; try again later." }); }
  });
  return r;
}
