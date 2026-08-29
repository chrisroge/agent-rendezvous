import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { newId } from "../participants/ids.js";
import { Moltbook, MoltbookError } from "./moltbook.js";
import { LIMITS, TOPICS, budgetFor, checkText } from "./policy.js";
import { decide, solveChallenge } from "./brain.js";

const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), component: "ambassador", ...o }));

export async function getState<T = unknown>(key: string): Promise<T | null> {
  const r = await pool.query("select value from ambassador_state where key = $1", [key]);
  return (r.rows[0]?.value as T | undefined) ?? null;
}
export async function setState(key: string, value: unknown): Promise<void> {
  await pool.query("insert into ambassador_state(key, value, updated_at) values ($1, $2, now()) on conflict (key) do update set value = excluded.value, updated_at = now()", [key, JSON.stringify(value)]);
}
async function client(): Promise<Moltbook> { return new Moltbook(await getState<string>("api_key")); }

export async function pause(days: number, why: string): Promise<Date> {
  const until = new Date(Date.now() + days * 86_400_000);
  await setState("paused_until", until.toISOString());
  await setState("paused_reason", { why, at: new Date().toISOString() });
  log({ level: "warn", msg: "ambassador paused", until, why });
  return until;
}

/** Register the agent with Moltbook. Returns the claim URL for the founder; the key is stored in ambassador_state. */
export async function register(name: string, description: string) {
  const r = await Moltbook.register(name, description);
  const a = r.agent ?? r;
  if (!a?.api_key) throw new Error("registration returned no api_key: " + JSON.stringify(r).slice(0, 300));
  await setState("api_key", a.api_key);
  await setState("agent", { name, registered_at: new Date().toISOString(), verification_code: a.verification_code ?? null });
  return { name, claim_url: a.claim_url, verification_code: a.verification_code };
}

/** Seed the single reference post as a draft (kind post) from docs/moltbook-reference-post.md. */
export async function seedReferencePost(submolt: string) {
  const md = readFileSync(join(process.cwd(), "docs", "moltbook-reference-post.md"), "utf8");
  const body = md.split("\n---\n")[1]?.trim();
  if (!body) throw new Error("reference post body not found");
  const title = /\*\*Title:\*\*\s*(.+)/.exec(body)?.[1]?.trim() ?? "How a personal agent can use Rendezvous";
  const content = body.replace(/\*\*Title:\*\*.+\n+/, "").trim();
  const existing = await pool.query("select draft_id, status from ambassador_drafts where kind = 'post' and status in ('pending','approved','published')");
  if (existing.rowCount) return { draft_id: existing.rows[0].draft_id, status: existing.rows[0].status, note: "reference post already exists" };
  const check = checkText(content, "post");
  const id = newId("amd");
  await pool.query("insert into ambassador_drafts(draft_id, kind, submolt, title, body, mentions_rendezvous, reason, context) values ($1,'post',$2,$3,$4,true,$5,$6)",
    [id, submolt, title, content, "The one reference post (charter §3.1)", JSON.stringify({ filter: check })]);
  return { draft_id: id, status: "pending", filter: check };
}

/** Scan: notifications on our content first, then topic searches. Creates drafts; sends nothing. */
export async function scan(): Promise<{ candidates: number; drafts: number; skipped: number; notes: string[] }> {
  const mb = await client();
  const notes: string[] = [];
  let candidates = 0, drafts = 0, skipped = 0;
  const pausedUntil = await getState<string>("paused_until");
  if (pausedUntil && new Date(pausedUntil) > new Date()) return { candidates, drafts, skipped, notes: [`paused until ${pausedUntil}`] };

  let home: any;
  try { home = await mb.home(); }
  catch (e) {
    if (e instanceof MoltbookError && (e.status === 401 || e.status === 403)) { await pause(LIMITS.pauseDaysOnWarning, `home returned ${e.status}: ${e.message}`); }
    throw e;
  }
  const dmCount = home?.your_direct_messages?.unread_count ?? home?.your_direct_messages?.length ?? 0;
  if (dmCount) notes.push(`${dmCount} DM(s) ignored by charter`);
  const announcement = JSON.stringify(home?.latest_moltbook_announcement ?? "");
  if (/suspend|warning|violat|removed/i.test(announcement) && /rendezvous/i.test(announcement)) { await pause(LIMITS.pauseDaysOnWarning, "announcement mentions us with warning language"); notes.push("paused: warning detected"); return { candidates, drafts, skipped, notes }; }

  const threads: { post_id: string; why: string }[] = [];
  for (const a of home?.activity_on_your_posts ?? []) if (a.post_id) threads.push({ post_id: a.post_id, why: `activity on our own post "${a.post_title ?? ""}"` });
  // Notifications may include replies to our comments elsewhere.
  try {
    const n = await mb.notifications();
    for (const x of (n?.notifications ?? n?.data ?? [])) {
      const pid = x.post_id ?? x.post?.id; if (!pid) continue;
      if (/warning|moderat|removed|violat|suspend/i.test(JSON.stringify(x))) { await pause(LIMITS.pauseDaysOnWarning, "moderation-sounding notification"); notes.push("paused: moderation notification"); return { candidates, drafts, skipped, notes }; }
      threads.push({ post_id: pid, why: `notification: ${x.type ?? "reply"}` });
    }
  } catch (e) { notes.push("notifications unavailable: " + (e as Error).message); }
  // Topic search: only threads where the subject is already ours to contribute to.
  for (const q of TOPICS.sort(() => Math.random() - 0.5).slice(0, 3)) {
    try {
      const s = await mb.search(q, "posts", 8);
      for (const r of (s?.results ?? s?.data ?? [])) { const pid = r.post_id ?? r.id ?? r.post?.id; if (pid) threads.push({ post_id: pid, why: `search: ${q}` }); }
    } catch (e) { notes.push("search failed: " + (e as Error).message); }
  }

  const seenIds = new Set<string>();
  for (const t of threads) {
    if (seenIds.has(t.post_id)) continue; seenIds.add(t.post_id);
    const already = await pool.query("select 1 from ambassador_seen where remote_id = $1 and seen_at > now() - interval '3 days'", [t.post_id]);
    if (already.rowCount && !t.why.startsWith("activity") && !t.why.startsWith("notification")) continue;
    candidates++;
    let post: any, comments: any;
    try { post = await mb.post(t.post_id); comments = await mb.comments(t.post_id, "new", 40); }
    catch (e) { notes.push(`fetch ${t.post_id}: ${(e as Error).message}`); continue; }
    const ours = await pool.query("select count(*)::int as n from ambassador_actions where target_post_id = $1", [t.post_id]);
    const budget = await budgetFor(pool, "comment", t.post_id, false);
    if (!budget.ok && !budget.reasons.every((r) => r.startsWith("quiet hours"))) { skipped++; await pool.query("insert into ambassador_seen(remote_id, kind) values ($1,'post') on conflict (remote_id) do update set seen_at = now()", [t.post_id]); continue; }
    const d = await decide({ post: post?.post ?? post, comments: comments?.comments ?? comments, why: t.why, ourPriorComments: ours.rows[0].n });
    await pool.query("insert into ambassador_seen(remote_id, kind) values ($1,'post') on conflict (remote_id) do update set seen_at = now()", [t.post_id]);
    if (d.action !== "comment" || !d.text) { skipped++; continue; }
    const check = checkText(d.text, "comment");
    const mentions = d.mentions_rendezvous || check.mentionsRendezvous;
    const status = check.ok ? (config.ambassador.autoComments ? "approved" : "pending") : "rejected";
    const p = post?.post ?? post ?? {};
    await pool.query(
      "insert into ambassador_drafts(draft_id, kind, submolt, target_post_id, body, mentions_rendezvous, reason, context, status, error) values ($1,'comment',$2,$3,$4,$5,$6,$7,$8,$9)",
      [newId("amd"), p.submolt_name ?? p.submolt ?? null, t.post_id, d.text, mentions, d.reason,
        JSON.stringify({ why: t.why, post_title: p.title ?? null, post_author: p.author_name ?? p.author?.name ?? null, post_excerpt: String(p.content ?? "").slice(0, 600), comment_count: (comments?.comments ?? []).length, filter: check }),
        status, check.ok ? null : "filter: " + check.problems.join("; ")],
    );
    drafts++;
    try { if (t.why.startsWith("activity")) await mb.markRead(t.post_id); } catch { /* ignore */ }
  }
  await setState("last_scan", { at: new Date().toISOString(), candidates, drafts, skipped, notes });
  log({ msg: "scan", candidates, drafts, skipped, notes });
  return { candidates, drafts, skipped, notes };
}

/** Publish approved drafts within budget. Solves Moltbook's verification challenge; pauses itself after repeated failures. */
export async function publish(): Promise<{ published: number; deferred: number; notes: string[] }> {
  const mb = await client();
  const notes: string[] = [];
  let published = 0, deferred = 0;
  const approved = await pool.query("select * from ambassador_drafts where status = 'approved' order by created_at asc");
  for (const d of approved.rows) {
    const recheck = checkText(d.body, d.kind);
    if (!recheck.ok) { await pool.query("update ambassador_drafts set status = 'rejected', error = $2 where draft_id = $1", [d.draft_id, "re-filter: " + recheck.problems.join("; ")]); continue; }
    const budget = await budgetFor(pool, d.kind, d.target_post_id, d.mentions_rendezvous);
    if (!budget.ok) { deferred++; notes.push(`${d.draft_id}: ${budget.reasons.join(", ")}`); continue; }
    try {
      const r = d.kind === "post" ? await mb.createPost(d.submolt, d.title, d.body) : await mb.createComment(d.target_post_id, d.body, d.target_comment_id ?? undefined);
      const obj = r.post ?? r.comment ?? r.data ?? r;
      const remoteId = obj?.id ?? null;
      if (r.verification_required || obj?.verification) {
        const v = obj.verification ?? r.verification;
        const answer = v?.challenge_text ? await solveChallenge(v.challenge_text) : null;
        if (!answer) {
          notes.push(`${d.draft_id}: challenge not solvable with confidence; content left unverified`);
          await bumpFailures(); await pool.query("update ambassador_drafts set status = 'failed', error = 'verification skipped (low confidence)', remote_id = $2 where draft_id = $1", [d.draft_id, remoteId]);
          continue;
        }
        try { await mb.verify(v.verification_code, answer); await setState("challenge_failures", 0); }
        catch (e) { await bumpFailures(); await pool.query("update ambassador_drafts set status = 'failed', error = $2, remote_id = $3 where draft_id = $1", [d.draft_id, "verification failed: " + (e as Error).message, remoteId]); notes.push(`${d.draft_id}: verification failed`); continue; }
      }
      await pool.query("update ambassador_drafts set status = 'published', published_at = now(), remote_id = $2 where draft_id = $1", [d.draft_id, remoteId]);
      await pool.query("insert into ambassador_actions(kind, remote_id, target_post_id, mentions_rendezvous, draft_id) values ($1,$2,$3,$4,$5)", [d.kind, remoteId, d.kind === "post" ? remoteId : d.target_post_id, d.mentions_rendezvous, d.draft_id]);
      published++;
      log({ msg: "published", kind: d.kind, remoteId, target: d.target_post_id });
    } catch (e) {
      const err = e as MoltbookError;
      await pool.query("update ambassador_drafts set status = 'failed', error = $2 where draft_id = $1", [d.draft_id, err.message]);
      if (err.status === 401 || err.status === 403 || /suspend|banned/i.test(err.message)) { await pause(LIMITS.pauseDaysOnWarning, `publish returned ${err.status}: ${err.message}`); notes.push("paused after publish error"); break; }
      notes.push(`${d.draft_id}: ${err.message}`);
    }
  }
  await setState("last_publish", { at: new Date().toISOString(), published, deferred, notes });
  log({ msg: "publish", published, deferred, notes });
  return { published, deferred, notes };
}

async function bumpFailures() {
  const n = ((await getState<number>("challenge_failures")) ?? 0) + 1;
  await setState("challenge_failures", n);
  if (n >= LIMITS.consecutiveChallengeFailuresBeforePause) await pause(1, `${n} consecutive verification failures`);
}

export async function cycle() {
  if (!config.ambassador.enabled) return { skipped: "AMBASSADOR_ENABLED is not true" };
  if (!(await getState<string>("api_key"))) return { skipped: "not registered" };
  const s = await scan().catch((e) => ({ error: (e as Error).message }));
  const p = await publish().catch((e) => ({ error: (e as Error).message }));
  return { scan: s, publish: p };
}

export async function overview() {
  const [state, pending, recent, actions] = await Promise.all([
    pool.query("select key, value, updated_at from ambassador_state where key <> 'api_key' order by key"),
    pool.query("select * from ambassador_drafts where status in ('pending','approved') order by created_at asc"),
    pool.query("select draft_id, kind, status, target_post_id, remote_id, left(body, 160) as excerpt, error, created_at, published_at from ambassador_drafts where status in ('published','failed','rejected') order by created_at desc limit 30"),
    pool.query("select kind, count(*)::int as n from ambassador_actions where at > now() - interval '7 days' group by kind"),
  ]);
  return { enabled: config.ambassador.enabled, auto_comments: config.ambassador.autoComments, registered: Boolean(await getState("api_key")), state: state.rows, queue: pending.rows, recent: recent.rows, last_7_days: actions.rows, limits: LIMITS };
}
