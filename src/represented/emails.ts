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
