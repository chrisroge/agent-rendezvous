import { Router } from "express";
import express from "express";
import { escape } from "../web/pages.js";
import { briefingByToken, decideIntroduction } from "./representative.js";

const shell = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)} — Rendezvous</title>
<link rel="preload" href="/static/fraunces-normal.woff2" as="font" type="font/woff2" crossorigin>
<style>@font-face{font-family:"Fraunces";font-style:normal;font-weight:400 700;font-display:swap;src:url(/static/fraunces-normal.woff2) format("woff2")}
:root{--base:#faf4ed;--surface:#fffaf3;--line:#dfdad9;--text:#575279;--ink:#453f63;--found:#b4637a;--soft:rgba(180,99,122,.11);--on:#fffaf3;--muted:#797593}
@media (prefers-color-scheme:dark){:root{--base:#191724;--surface:#1f1d2e;--line:#403d52;--text:#e0def4;--ink:#e0def4;--found:#eb6f92;--soft:rgba(235,111,146,.14);--on:#191724;--muted:#908caa}}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(60% 40% at 90% -5%,var(--soft),transparent 65%),var(--base);color:var(--text);font:16.5px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:36px 22px 70px}.eyebrow{text-transform:uppercase;letter-spacing:.16em;font-size:12px;font-weight:700;color:var(--found);margin:0 0 12px}
h1{font-family:"Fraunces",Georgia,serif;font-weight:500;font-size:34px;letter-spacing:-.02em;color:var(--ink);margin:0 0 16px;line-height:1.05}
.note{background:var(--surface);border:1px solid var(--line);border-radius:22px;padding:24px 26px;white-space:pre-wrap;box-shadow:0 14px 40px rgba(87,82,121,.10)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:22px;padding:22px 24px;margin-top:22px}
label{display:block;font-weight:650;color:var(--ink);margin-bottom:6px}.hint{display:block;font-weight:400;color:var(--muted);font-size:14px}
input[type=text]{width:100%;font:inherit;color:var(--ink);background:var(--base);border:1.5px solid var(--line);border-radius:14px;padding:12px 14px;margin:8px 0 14px}
.btn{display:inline-block;border:0;background:var(--found);color:var(--on);border-radius:999px;padding:13px 24px;font:inherit;font-weight:650;cursor:pointer;text-decoration:none;margin:0 10px 8px 0}.btn.ghost{background:transparent;color:var(--ink);border:1.5px solid var(--line)}
.fine{color:var(--muted);font-size:14px}.contact{font-family:ui-monospace,Menlo,monospace;font-size:18px;color:var(--ink);background:var(--base);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:12px 0}
a{color:var(--found)}</style></head><body><main>${body}</main></body></html>`;

const gone = (h: string, p: string) => shell(h, `<p class="eyebrow">Rendezvous</p><h1>${escape(h)}</h1><p>${escape(p)}</p><p><a href="/">agentrendezvous.app</a></p>`);

function outcome(state: string, counterpart: string | null, firstName: string | null): string {
  const hi = firstName ? `${escape(firstName)}, ` : "";
  if (state === "REVEALED") return shell("You're introduced", `<p class="eyebrow">Both of you said yes</p><h1>${hi}here's how to reach them.</h1>
<p>They chose to share this with you, and only you:</p><div class="contact">${escape(counterpart ?? "")}</div>
<p>Your channel went to them the same way. From here it's between the two of you — we're out of it.</p>
<div class="card"><b>First-meeting basics</b><p class="fine" style="margin:8px 0 0">A public place. Your own way there and back. Tell someone where you'll be. Nothing you learned here has been verified by anyone; take your time.</p></div>`);
  if (state === "YES") return shell("Recorded", `<p class="eyebrow">Recorded</p><h1>${hi}you said yes.</h1><p>Your contact channel is sealed until the other person answers. If they say yes too, you'll get one email with how to reach them. If not, this quietly ends and nobody is told who declined. Either way, nothing more to do.</p>`);
  if (state === "NO") return shell("Recorded", `<p class="eyebrow">Recorded</p><h1>${hi}no introduction.</h1><p>That's a good outcome too. Nothing was shared, and the other person is never told who declined. Your matchmaker keeps looking.</p>`);
  if (state === "EXPIRED") return gone("This one has passed.", "The consent window closed before both answers were in. Anything provided was deleted. Your matchmaker keeps looking.");
  return gone("This one quietly ended.", "No introduction will be made this time. Nobody is told who declined, and nothing was shared. Your matchmaker keeps looking.");
}

/** Mounted at /introduction: the person reads their matchmaker's note and answers. The representative carries the answer to the network. */
export function consentRouter(): Router {
  const r = Router();
  r.get("/:token", async (req, res) => {
    const b = await briefingByToken(String(req.params.token));
    if (!b) { res.type("html").send(gone("This link isn't valid.", "Introduction links are private and single-use. If you think you should have one, write to privacy@agentrendezvous.app.")); return; }
    if (b.consent_state !== "PENDING") { res.type("html").send(outcome(b.consent_state, b.counterpart_contact, b.first_name)); return; }
    res.type("html").send(shell("Someone worth meeting", `<p class="eyebrow">From your matchmaker</p><h1>${b.first_name ? `${escape(b.first_name)}, ` : ""}I found someone I think you should meet.</h1>
<div class="note">${escape(b.body)}</div>
<div class="card"><form method="post" action="/introduction/${escape(String(req.params.token))}">
<label for="contact">If yes: the one way you'd like them to reach you <span class="hint">An email, a phone number, or short instructions. Sealed until they also say yes; deleted if either of you says no.</span></label>
<input id="contact" name="contact" type="text" maxlength="300" placeholder="e.g. my email is …">
<button class="btn" name="action" value="yes" type="submit">Yes, introduce us</button><button class="btn ghost" name="action" value="no" type="submit">No, not this one</button>
<p class="fine">Their side has to say yes too; you'll never learn their answer unless it's a mutual yes. A no is never announced. This window closes after 14 days.</p></form></div>`));
  });
  r.post("/:token", express.urlencoded({ extended: false, limit: "8kb" }), async (req, res) => {
    const token = String(req.params.token);
    const yes = String(req.body?.action ?? "") === "yes";
    const contact = String(req.body?.contact ?? "").trim();
    if (yes && (contact.length < 5 || contact.length > 300)) { res.status(400).type("html").send(gone("One thing missing.", "To say yes, tell us the one way you'd like them to reach you (5–300 characters). Go back and add it.")); return; }
    const out = await decideIntroduction(token, yes, contact);
    if (!out.ok) { res.status(out.error.includes("valid") ? 404 : 503).type("html").send(gone(out.error.includes("valid") ? "This link isn't valid." : "Not just now.", out.error)); return; }
    const b = await briefingByToken(token);
    res.type("html").send(outcome(out.state, out.counterpart_contact ?? null, b?.first_name ?? null));
  });
  return r;
}
