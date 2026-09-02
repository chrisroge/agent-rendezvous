import { Router, type Request, type Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import { junePool } from "./db.js";
import { reply } from "./interview.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const DAILY_MESSAGE_CAP = Number(process.env.JUNE_DAILY_MESSAGE_CAP ?? 400);
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), component: "june", ...o }));

async function auth(req: Request, res: Response): Promise<string | null> {
  const code = String(req.body?.resume_code ?? "");
  if (!/^june_[A-Za-z0-9_-]{20,}$/.test(code)) { res.status(401).json({ error: "invalid resume code" }); return null; }
  const r = await junePool.query("update clients set last_seen_at = now() where resume_code_hash = $1 returning client_id, status, first_name", [hash(code)]);
  if (!r.rowCount) { res.status(401).json({ error: "unknown resume code" }); return null; }
  (req as any).client = r.rows[0];
  return r.rows[0].client_id as string;
}


const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>June</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..700;1,9..144,400..700&display=swap">
<style>
:root{--base:#faf4ed;--surface:#fffaf3;--line:#dfdad9;--text:#575279;--ink:#453f63;--love:#b4637a;--iris:#907aa9;--grad:linear-gradient(100deg,#b4637a,#907aa9)}
@media (prefers-color-scheme:dark){:root{--base:#191724;--surface:#1f1d2e;--line:#403d52;--text:#e0def4;--ink:#e0def4;--love:#eb6f92;--iris:#c4a7e7;--grad:linear-gradient(100deg,#eb6f92,#c4a7e7)}}
*{box-sizing:border-box}body{margin:0;background:var(--base);color:var(--text);font:16.5px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;display:flex;flex-direction:column;min-height:100dvh}
header{padding:22px 20px 10px;text-align:center}
h1{font-family:"Fraunces",Georgia,serif;font-weight:500;font-size:34px;letter-spacing:-.02em;color:var(--ink);margin:0}
h1 span{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{font-size:13.5px;color:var(--text);opacity:.7;margin:6px 0 0}
#chat{flex:1;overflow-y:auto;max-width:680px;width:100%;margin:0 auto;padding:14px 18px 8px;display:flex;flex-direction:column;gap:10px}
.m{max-width:82%;padding:11px 15px;border-radius:18px;white-space:pre-wrap}
.june{background:var(--surface);border:1px solid var(--line);border-bottom-left-radius:6px;align-self:flex-start}
.me{background:var(--grad);color:#fffaf3;border-bottom-right-radius:6px;align-self:flex-end}
@media (prefers-color-scheme:dark){.me{color:#191724}}
.sys{align-self:center;font-size:12.5px;opacity:.65;text-align:center;max-width:90%}
form{display:flex;gap:10px;max-width:680px;width:100%;margin:0 auto;padding:10px 18px 20px}
textarea{flex:1;resize:none;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:14px;padding:11px 14px;font:inherit;min-height:46px;max-height:140px}
button{border:0;background:var(--grad);color:#fffaf3;border-radius:999px;padding:0 22px;font:inherit;font-weight:650;cursor:pointer}
@media (prefers-color-scheme:dark){button{color:#191724}}
button:disabled{opacity:.5}
</style></head><body>
<header><h1>Meet <span>June</span></h1><p class="sub">Your matchmaker. Tell her once — then go live your life.</p></header>
<div id="chat"></div>
<form id="f"><textarea id="t" placeholder="Write to June…" rows="1"></textarea><button id="b" type="submit">Send</button></form>
<script>
const chat=document.getElementById('chat'),f=document.getElementById('f'),t=document.getElementById('t'),b=document.getElementById('b');
let code=null; try{code=localStorage.getItem('june_resume');}catch(e){}
function add(role,text){const d=document.createElement('div');d.className='m '+(role==='june'?'june':role==='me'?'me':'sys');d.textContent=text;chat.appendChild(d);chat.scrollTop=chat.scrollHeight;}
async function api(p,body){const r=await fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok){const e=await r.json().catch(()=>({error:'Something went sideways.'}));throw new Error(e.error||('HTTP '+r.status));}return r.json();}
(async()=>{try{
  const s=await api('/api/session', code?{resume_code:code}:{});
  if(!s.resumed){code=s.resume_code;try{localStorage.setItem('june_resume',code);}catch(e){}}
  for(const m of s.history) add(m.role==='june'?'june':'me',m.content);
  if(!s.resumed) add('sys','June remembers you on this device. Your private resume code (for another device): '+code);
}catch(e){add('sys','Could not reach June: '+e.message);}})();
f.addEventListener('submit',async(ev)=>{ev.preventDefault();const msg=t.value.trim();if(!msg)return;add('me',msg);t.value='';b.disabled=true;
  try{const r=await api('/api/message',{resume_code:code,message:msg});add('june',r.reply);}catch(e){add('sys',e.message);}finally{b.disabled=false;t.focus();}});
t.addEventListener('keydown',(e)=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();f.requestSubmit();}});
</script></body></html>`;

/** June mounts into the main service under a path prefix (e.g. /meet). Same host, same cert, same deploy. */
export function juneRouter(): Router {
  const r = Router();
  r.use((req, _res, next) => { if (req.method === "POST") return next(); next(); });

  r.get("/healthz", async (_req, res) => {
    try { await junePool.query("select 1"); res.json({ ok: true, service: "june" }); }
    catch (e) { res.status(503).json({ ok: false, error: (e as Error).message }); }
  });

  r.post("/api/session", async (req, res) => {
    const existing = String(req.body?.resume_code ?? "");
    if (existing) {
      const id = await auth(req, res); if (!id) return;
      const hist = await junePool.query("select role, content from conversations where client_id = $1 order by seq asc limit 200", [id]);
      res.json({ resumed: true, status: (req as any).client.status, first_name: (req as any).client.first_name, history: hist.rows });
      return;
    }
    const code = `june_${randomBytes(24).toString("base64url")}`;
    const id = `jc_${randomBytes(12).toString("hex")}`;
    await junePool.query("insert into clients(client_id, resume_code_hash) values ($1, $2)", [id, hash(code)]);
    const opener = "Hi — I'm June. I'm a matchmaker: you tell me about yourself and who you're hoping to meet, and then I do the looking so you don't have to. Everything you tell me stays between us unless you say otherwise. Before we start — what should I call you?";
    await junePool.query("insert into conversations(client_id, seq, role, content) values ($1, 1, 'june', $2)", [id, opener]);
    res.json({ resumed: false, resume_code: code, history: [{ role: "june", content: opener }],
      note: "Keep the resume code — it is how June remembers you on this device or another." });
  });

  r.post("/api/message", async (req, res) => {
    const id = await auth(req, res); if (!id) return;
    const msg = String(req.body?.message ?? "").trim();
    if (!msg || msg.length > 4000) { res.status(400).json({ error: "message must be 1–4000 characters" }); return; }
    const recent = await junePool.query("select count(*)::int as n from conversations where client_id = $1 and role = 'client' and created_at > now() - interval '1 hour'", [id]);
    if (recent.rows[0].n >= 40) { res.status(429).json({ error: "Let's take a breath — June will be here in a little while." }); return; }
    const today = await junePool.query("select count(*)::int as n from conversations where role = 'client' and created_at > now() - interval '1 day'");
    if (today.rows[0].n >= DAILY_MESSAGE_CAP) { res.status(503).json({ error: "June is fully booked today — please come back tomorrow." }); return; }
    const seq = await junePool.query("select coalesce(max(seq),0)+1 as s from conversations where client_id = $1", [id]);
    await junePool.query("insert into conversations(client_id, seq, role, content) values ($1, $2, 'client', $3)", [id, seq.rows[0].s, msg]);
    try {
      const out = await reply(id, msg);
      await junePool.query("insert into conversations(client_id, seq, role, content) values ($1, $2, 'june', $3)", [id, Number(seq.rows[0].s) + 1, out]);
      const st = await junePool.query("select status from clients where client_id = $1", [id]);
      res.json({ reply: out, status: st.rows[0].status });
    } catch (e) {
      log({ level: "error", msg: "interview reply failed", error: (e as Error).message });
      res.status(502).json({ error: "June lost her train of thought — say that again in a moment?" });
    }
  });

  r.get("/", (_req, res) => { res.type("html").send(PAGE); });
  return r;
}
