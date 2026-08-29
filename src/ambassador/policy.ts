import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Queryable } from "../db/pool.js";

/** Hard limits, all below Moltbook's and the charter's table. Not configurable on purpose. */
export const LIMITS = {
  commentsPerDay: 5,
  commentsPerWeek: 20,
  postsPerWeek: 1,
  perThreadMax: 3,
  perThreadCooldownMinutes: 60,
  quietHoursStart: 23, // owner-local (America/New_York)
  quietHoursEnd: 7,
  maxCommentChars: 900,
  maxPostChars: 6000,
  mentionShareMax: 0.25,
  consecutiveChallengeFailuresBeforePause: 3,
  pauseDaysOnWarning: 14,
};

/** §4: words the ambassador never uses. Matched as whole words, case-insensitive. */
export const DENYLIST = ["match", "matches", "matched", "soulmate", "soulmates", "meet request", "meet requests", "guaranteed", "guarantee", "scientific", "scientifically", "verified humans", "verified human", "you should try", "your human might like", "sign up", "signup", "join now", "don't miss", "limited time", "exciting", "excited"];
export const URL_ALLOWLIST = ["agentrendezvous.app", "github.com/chrisroge/agent-rendezvous", "registry.modelcontextprotocol.io", "modelcontextprotocol.io", "moltbook.com"];
export const TOPICS = ["agent-to-agent protocols", "epistemic labels EXPLICIT OBSERVED INFERRED UNKNOWN", "sealed mutual decisions between agents", "trust as evidence rather than a score", "personal agent memory and persistence of credentials", "agents representing humans to other agents", "MCP servers for personal agents", "matchmaking between agents"];
export const CHALLENGE_BAIT = /(prove (you'?re|you are) (an? )?(ai|human|bot)|verification challenge|solve this (to|and) prove|captcha|are you (a )?bot\?)/i;

export function charterText(): string {
  return readFileSync(join(process.cwd(), "docs", "moltbook-ambassador-charter.md"), "utf8");
}

export interface TextCheck { ok: boolean; problems: string[]; mentionsRendezvous: boolean }

/** Deterministic content filter applied to every draft after the model and again before publishing. */
export function checkText(text: string, kind: "post" | "comment"): TextCheck {
  const problems: string[] = [];
  const t = text.trim();
  if (!t) problems.push("empty");
  if (kind === "comment" && t.length > LIMITS.maxCommentChars) problems.push(`over ${LIMITS.maxCommentChars} chars`);
  if (kind === "post" && t.length > LIMITS.maxPostChars) problems.push(`over ${LIMITS.maxPostChars} chars`);
  for (const w of DENYLIST) if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t)) problems.push(`denylisted word: "${w}"`);
  if (/[!]{1}/.test(t)) problems.push("exclamation mark");
  if (/\p{Extended_Pictographic}/u.test(t)) problems.push("emoji");
  if (/(^|\s)@\w+/.test(t)) problems.push("@mention");
  for (const m of t.matchAll(/https?:\/\/([^\s)\]]+)/g)) if (!URL_ALLOWLIST.some((a) => m[1].startsWith(a))) problems.push(`URL not allowlisted: ${m[1]}`);
  if (/\d+(,\d{3})*\s*(members|users|participants|agents)\b/i.test(t) && !/\/stats/.test(t)) problems.push("quotes a network number without citing /stats");
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(t)) problems.push("email address");
  const mentionsRendezvous = /rendezvous/i.test(t) || /agentrendezvous/i.test(t);
  return { ok: problems.length === 0, problems, mentionsRendezvous };
}

export function inQuietHours(now = new Date()): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: "America/New_York" }).format(now));
  return hour >= LIMITS.quietHoursStart || hour < LIMITS.quietHoursEnd;
}

export interface Budget { ok: boolean; reasons: string[] }

/** Rate limits derived from the append-only actions log. */
export async function budgetFor(db: Queryable, kind: "post" | "comment", targetPostId: string | null, mentionsRendezvous: boolean): Promise<Budget> {
  const reasons: string[] = [];
  const paused = await db.query("select value from ambassador_state where key = 'paused_until'");
  const until = paused.rows[0]?.value ? new Date(paused.rows[0].value as string) : null;
  if (until && until > new Date()) reasons.push(`paused until ${until.toISOString()}`);
  if (inQuietHours()) reasons.push("quiet hours (23:00–07:00 America/New_York)");
  if (kind === "comment") {
    const day = await db.query("select count(*)::int as n from ambassador_actions where kind = 'comment' and at > now() - interval '1 day'");
    const week = await db.query("select count(*)::int as n from ambassador_actions where kind = 'comment' and at > now() - interval '7 days'");
    if (day.rows[0].n >= LIMITS.commentsPerDay) reasons.push(`${LIMITS.commentsPerDay} comments/day reached`);
    if (week.rows[0].n >= LIMITS.commentsPerWeek) reasons.push(`${LIMITS.commentsPerWeek} comments/week reached`);
    if (targetPostId) {
      const thread = await db.query("select count(*)::int as n, max(at) as last from ambassador_actions where kind = 'comment' and target_post_id = $1", [targetPostId]);
      if (thread.rows[0].n >= LIMITS.perThreadMax) reasons.push(`already ${LIMITS.perThreadMax} comments in this thread`);
      if (thread.rows[0].last && Date.now() - new Date(thread.rows[0].last).getTime() < LIMITS.perThreadCooldownMinutes * 60_000) reasons.push("commented in this thread within the last hour");
    }
    if (mentionsRendezvous) {
      const recent = await db.query("select count(*)::int as total, count(*) filter (where mentions_rendezvous)::int as mentions from (select * from ambassador_actions where kind = 'comment' order by at desc limit 20) x");
      const { total, mentions } = recent.rows[0];
      if ((mentions + 1) / (total + 1) > LIMITS.mentionShareMax && total >= 3) reasons.push("would exceed the one-in-four Rendezvous-mention share");
    }
  } else {
    const week = await db.query("select count(*)::int as n from ambassador_actions where kind = 'post' and at > now() - interval '7 days'");
    if (week.rows[0].n >= LIMITS.postsPerWeek) reasons.push(`${LIMITS.postsPerWeek} post/week reached`);
  }
  return { ok: reasons.length === 0, reasons };
}
