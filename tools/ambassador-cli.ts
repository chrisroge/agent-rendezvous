/**
 * Founder's review desk for the Moltbook ambassador. Thin client over the operator API (the DB is private).
 *   BASE_URL=https://agentrendezvous.app OPERATOR_TOKEN=... npm run ambassador -- <command>
 * Commands: status | queue | show <id> | approve <id> [--edit] | reject <id> | register "<bio>" | profile "<bio>" |
 *           seed-post <submolt> | run [scan|publish|cycle] | pause [days] | resume | moltbook
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE_URL ?? "https://agentrendezvous.app";
const TOKEN = process.env.OPERATOR_TOKEN ?? (() => { try { return execSync("aws secretsmanager get-secret-value --region us-east-2 --secret-id rendezvous/operator-token --query SecretString --output text", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; } })();
if (!TOKEN) { console.error("OPERATOR_TOKEN missing (or aws CLI not configured)"); process.exit(1); }

async function api(path: string, method = "GET", body?: unknown) {
  const r = await fetch(`${BASE}/admin/ambassador${path}`, { method, headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let d: any; try { d = JSON.parse(t); } catch { d = t; }
  if (!r.ok) { console.error(`HTTP ${r.status}`, d); process.exit(1); }
  return d;
}
const [cmd, ...rest] = process.argv.slice(2);
const bio = `Operated by Rendezvous (agentrendezvous.app), a matchmaking network for personal AI agents. I'm an AI. I answer questions about how agents can use the network; I don't recruit, DM, or discuss anyone's private life. Docs: agentrendezvous.app/for-agents.`;

function printDraft(d: any) {
  console.log(`\n── ${d.draft_id} · ${d.kind} · ${d.status} · ${new Date(d.created_at).toLocaleString()}${d.mentions_rendezvous ? " · mentions Rendezvous" : ""}`);
  if (d.context?.post_title) console.log(`   thread: "${d.context.post_title}" by ${d.context.post_author ?? "?"} (${d.context.why ?? ""})`);
  if (d.context?.post_excerpt) console.log(`   post: ${String(d.context.post_excerpt).replace(/\s+/g, " ").slice(0, 300)}`);
  if (d.reason) console.log(`   why: ${d.reason}`);
  if (d.error) console.log(`   note: ${d.error}`);
  console.log(`   ─ text ─\n   ${String(d.body).split("\n").join("\n   ")}`);
}

(async () => {
  switch (cmd) {
    case "status": { const o = await api(""); console.log({ enabled: o.enabled, auto_comments: o.auto_comments, registered: o.registered, queue: o.queue.length, last_7_days: o.last_7_days, state: o.state }); break; }
    case "queue": { const o = await api(""); if (!o.queue.length) console.log("queue empty"); for (const d of o.queue) printDraft(d); console.log(`\n${o.queue.length} awaiting decision. approve <id> | reject <id> | approve <id> --edit`); break; }
    case "show": { const o = await api(""); const d = [...o.queue, ...o.recent].find((x: any) => x.draft_id === rest[0]); d ? printDraft(d) : console.log("not found"); break; }
    case "approve": {
      let body: string | undefined;
      if (rest.includes("--edit")) { const o = await api(""); const d = o.queue.find((x: any) => x.draft_id === rest[0]); if (!d) { console.log("not found"); break; }
        const f = join(tmpdir(), `${d.draft_id}.txt`); writeFileSync(f, d.body); execSync(`${process.env.EDITOR ?? "nano"} ${f}`, { stdio: "inherit" }); body = readFileSync(f, "utf8").trim(); }
      console.log(await api(`/drafts/${rest[0]}/approve`, "POST", body ? { body } : {})); break; }
    case "reject": console.log(await api(`/drafts/${rest[0]}/reject`, "POST", {})); break;
    case "register": console.log(await api("/register", "POST", { name: process.env.AMBASSADOR_NAME ?? "Rendezvous", description: rest[0] ?? bio })); console.log("\nOpen the claim_url with the DEDICATED X account (charter §2), then run: npm run ambassador -- moltbook"); break;
    case "profile": console.log(await api("/profile", "POST", { description: rest[0] ?? bio })); break;
    case "submolts": { const d = await api(rest[0] ? `/submolts?q=${encodeURIComponent(rest[0])}` : "/submolts"); console.log(JSON.stringify(d, null, 1).slice(0, 6000)); break; }
    case "moltbook": console.log(JSON.stringify(await api("/moltbook-status"), null, 1)); break;
    case "seed-post": console.log(await api("/seed-post", "POST", { submolt: rest[0] })); break;
    case "run": console.log(JSON.stringify(await api("/run", "POST", { action: rest[0] ?? "cycle" }), null, 1)); break;
    case "pause": console.log(await api("/pause", "POST", { days: Number(rest[0] ?? 14), reason: rest[1] ?? "founder" })); break;
    case "resume": console.log(await api("/resume", "POST", {})); break;
    default: console.log("commands: status | queue | show <id> | approve <id> [--edit] | reject <id> | register [bio] | profile [bio] | moltbook | submolts [query] | seed-post <submolt> | run [scan|publish|cycle] | pause [days] | resume");
  }
})().catch((e) => { console.error(e); process.exit(1); });
