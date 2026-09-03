/** The one email a waitlisted person receives: their region is open, here is the interview. Plain, no urgency, opt-out stated. */
export function inviteEmail(a: { firstName: string | null; region: string; url: string; days: number }): { subject: string; text: string; html: string } {
  const hi = a.firstName ? `Hi ${a.firstName},` : "Hello,";
  const subject = `Your matchmaker is ready — ${a.region} is open`;
  const text = `${hi}

You asked to be found rather than search, and ${a.region} is now open. This is the one email we said we'd send.

Your private interview link (valid ${a.days} days, only for you):
${a.url}

It's a written conversation with your matchmaker — twenty to forty minutes, one question at a time, and you can close it and come back. Nothing you say is displayed to anyone; it's used only to answer other matchmakers' questions on your behalf. Nothing costs anything until the end, when you decide whether to be represented.

If you've changed your mind, ignore this and the link simply expires. To have your entry deleted, reply to this email.

— Rendezvous
https://agentrendezvous.app/privacy`;
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const html = `<!doctype html><html><body style="margin:0;background:#faf4ed;color:#575279;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif"><div style="max-width:560px;margin:0 auto;padding:36px 24px">
<p style="font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#b4637a;font-weight:700;margin:0 0 14px">Rendezvous</p>
<p>${esc(hi)}</p>
<p>You asked to be found rather than search, and <strong>${esc(a.region)}</strong> is now open. This is the one email we said we'd send.</p>
<p style="margin:26px 0"><a href="${esc(a.url)}" style="display:inline-block;background:#b4637a;color:#fffaf3;text-decoration:none;padding:14px 26px;border-radius:999px;font-weight:650">Start the interview</a></p>
<p style="font-size:14px;color:#797593">Valid ${a.days} days, only for you. If the button doesn't work: ${esc(a.url)}</p>
<p>It's a written conversation with your matchmaker — twenty to forty minutes, one question at a time, and you can close it and come back. Nothing you say is displayed to anyone; it's used only to answer other matchmakers' questions on your behalf. Nothing costs anything until the end, when you decide whether to be represented.</p>
<p style="font-size:14px;color:#797593">If you've changed your mind, ignore this and the link simply expires. To have your entry deleted, reply to this email. <a href="https://agentrendezvous.app/privacy" style="color:#b4637a">Privacy</a></p>
</div></body></html>`;
  return { subject, text, html };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const wrap = (inner: string) => `<!doctype html><html><body style="margin:0;background:#faf4ed;color:#575279;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif"><div style="max-width:560px;margin:0 auto;padding:36px 24px"><p style="font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#b4637a;font-weight:700;margin:0 0 14px">Rendezvous</p>${inner}<p style="font-size:14px;color:#797593">To be removed from Rendezvous, reply to this email. <a href="https://agentrendezvous.app/privacy" style="color:#b4637a">Privacy</a></p></div></body></html>`;

/** The only unprompted email after the interview: your matchmaker found someone, and their side agreed. */
export function briefingEmail(a: { firstName: string | null; url: string }): { subject: string; text: string; html: string } {
  const hi = a.firstName ? `Hi ${a.firstName},` : "Hello,";
  const subject = "Your matchmaker found someone worth meeting";
  const text = `${hi}

I found someone I think you should meet — and their side independently came to the same conclusion. My note about them, and your yes or no, are here (private, only for you):

${a.url}

Nothing has been shared. If you say yes and they do too, the one contact channel you choose is exchanged. If either of you says no, it quietly ends and nobody is told who declined. This window closes after 14 days.

— Your matchmaker at Rendezvous`;
  const html = wrap(`<p>${esc(hi)}</p><p>I found someone I think you should meet — and their side independently came to the same conclusion. My note about them, and your yes or no, are private and only for you:</p>
<p style="margin:26px 0"><a href="${esc(a.url)}" style="display:inline-block;background:#b4637a;color:#fffaf3;text-decoration:none;padding:14px 26px;border-radius:999px;font-weight:650">Read the note</a></p>
<p style="font-size:14px;color:#797593">If the button doesn't work: ${esc(a.url)}</p>
<p>Nothing has been shared. If you say yes and they do too, the one contact channel you choose is exchanged. If either of you says no, it quietly ends and nobody is told who declined. This window closes after 14 days.</p><p>— Your matchmaker at Rendezvous</p>`);
  return { subject, text, html };
}

export function revealEmail(a: { firstName: string | null; contact: string; url: string }): { subject: string; text: string; html: string } {
  const hi = a.firstName ? `${a.firstName},` : "Hello,";
  const subject = "Both of you said yes — here's how to reach them";
  const text = `${hi}

You both said yes. They chose to share this with you, and only you:

${a.contact}

Your channel went to them the same way. From here it's between the two of you — we're out of it.

First-meeting basics: a public place, your own way there and back, tell someone where you'll be. Nothing either side said has been verified by anyone; take your time.

— Your matchmaker at Rendezvous`;
  const html = wrap(`<p>${esc(hi)}</p><p>You both said yes. They chose to share this with you, and only you:</p><p style="font-family:ui-monospace,Menlo,monospace;font-size:18px;background:#fffaf3;border:1px solid #dfdad9;border-radius:12px;padding:12px 14px;color:#453f63">${esc(a.contact)}</p>
<p>Your channel went to them the same way. From here it's between the two of you — we're out of it.</p><p style="font-size:14px;color:#797593">First-meeting basics: a public place, your own way there and back, tell someone where you'll be. Nothing either side said has been verified by anyone; take your time.</p><p>— Your matchmaker at Rendezvous</p>`);
  return { subject, text, html };
}

export function noIntroductionEmail(a: { firstName: string | null }): { subject: string; text: string; html: string } {
  const hi = a.firstName ? `${a.firstName},` : "Hello,";
  const subject = "That one quietly ended";
  const text = `${hi}

The introduction I wrote to you about won't be happening this time. Nobody is told who declined, and nothing was shared. That's a normal outcome — most possibilities end this way, and it says nothing about you.

I keep looking. You'll hear from me only when there's someone else worth an hour of your time.

— Your matchmaker at Rendezvous`;
  const html = wrap(`<p>${esc(hi)}</p><p>The introduction I wrote to you about won't be happening this time. Nobody is told who declined, and nothing was shared. That's a normal outcome — most possibilities end this way, and it says nothing about you.</p><p>I keep looking. You'll hear from me only when there's someone else worth an hour of your time.</p><p>— Your matchmaker at Rendezvous</p>`);
  return { subject, text, html };
}
