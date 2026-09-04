/**
 * Send one test invitation through the configured mail transport, so a new relay can be checked before anyone real is invited.
 *   npm run mail:smoke -- you@example.com            # uses MAIL_TRANSPORT / MAIL_FROM / MAIL_SMTP_* from the environment
 *   npm run mail:smoke -- --ethereal                  # uses a throwaway Ethereal SMTP account and prints a preview URL (nothing is delivered)
 */
import nodemailer from "nodemailer";

async function main() {
  const args = process.argv.slice(2);
  const ethereal = args.includes("--ethereal");
  const to = args.find((a) => !a.startsWith("--")) ?? "someone@example.invalid";
  if (ethereal) {
    const acct = await nodemailer.createTestAccount();
    process.env.MAIL_TRANSPORT = "smtp"; process.env.MAIL_FROM ||= "Rendezvous <matchmaker@agentrendezvous.app>";
    process.env.MAIL_SMTP_HOST = acct.smtp.host; process.env.MAIL_SMTP_PORT = String(acct.smtp.port); process.env.MAIL_SMTP_USER = acct.user; process.env.MAIL_SMTP_PASS = acct.pass;
  }
  const { sendMail, mailEnabled, mailTransport } = await import("../src/mail/ses.js");
  const { inviteEmail } = await import("../src/represented/emails.js");
  console.log(JSON.stringify({ transport: mailTransport(), enabled: mailEnabled(), to }));
  const r = await sendMail({ kind: "smoke", to, ...inviteEmail({ firstName: "Test", region: "Smoke Harbor", url: "https://agentrendezvous.app/interview/iv_smoke-not-a-real-link", days: 14 }) });
  console.log(JSON.stringify(r));
  if (ethereal && r.id) console.log("preview:", nodemailer.getTestMessageUrl({ messageId: r.id } as any) || "(open https://ethereal.email with the printed account to view)");
  const { pool } = await import("../src/db/pool.js");
  console.log(JSON.stringify((await pool.query("select kind, status, provider_id, error from mail_log order by mail_id desc limit 1")).rows[0]));
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
