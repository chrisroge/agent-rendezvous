import { pool } from "../db/pool.js";
import { newId } from "../participants/ids.js";
import { normalizeRegion } from "../discovery/eligibility.js";

export const AGE_BANDS = ["18-24", "25-29", "30-34", "35-39", "40-44", "45-49", "50-54", "55-59", "60-64", "65-69", "70+"] as const;
export const GENDER_OPTIONS = [["woman", "A woman"], ["man", "A man"], ["nonbinary", "Non-binary"], ["other", "Something else"]] as const;
export const SEEKING_OPTIONS = [["man", "Men"], ["woman", "Women"], ["nonbinary", "Non-binary people"], ["any", "Open to anyone"]] as const;

export interface WaitlistInput {
  email?: string; first_name?: string; region?: string; gender?: string; seeking?: string | string[]; age_band?: string;
  website?: string; // honeypot: humans never see it
}
export interface WaitlistCtx { ipHash: string | null; userAgent?: string; source?: string }
export type WaitlistResult =
  | { ok: true; first_name: string | null; region: string; waiting_in_region: number; already: boolean }
  | { ok: false; error: string; values: Record<string, string | string[]> };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PER_IP_PER_HOUR = 10, GLOBAL_PER_DAY = 500;

export async function addToWaitlist(input: WaitlistInput, ctx: WaitlistCtx): Promise<WaitlistResult> {
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const email = str(input.email, 200), first_name = str(input.first_name, 60), region = str(input.region, 80), gender = str(input.gender, 20), age_band = str(input.age_band, 10);
  const seekingRaw = Array.isArray(input.seeking) ? input.seeking : input.seeking ? [input.seeking] : [];
  const seeking = [...new Set(seekingRaw.map((s) => String(s).trim()).filter((s) => SEEKING_OPTIONS.some(([k]) => k === s)))];
  const values = { email, first_name, region, gender, seeking, age_band };
  const fail = (error: string): WaitlistResult => ({ ok: false, error, values });

  // Honeypot: a filled hidden field is a bot. Pretend it worked; store nothing.
  if (str(input.website, 10)) return { ok: true, first_name: first_name || null, region: region || "your area", waiting_in_region: 1, already: false };

  if (!EMAIL_RE.test(email)) return fail("That email address doesn't look right.");
  if (region.length < 2) return fail("Tell us roughly where you live — a city or area is enough, never an address.");
  if (!GENDER_OPTIONS.some(([k]) => k === gender)) return fail("Please tell us who you are.");
  if (seeking.length === 0) return fail("Please tell us who you're hoping to meet.");
  if (!(AGE_BANDS as readonly string[]).includes(age_band)) return fail("Please pick your age range. Rendezvous is for adults only.");

  if (ctx.ipHash) {
    const recent = await pool.query("select count(*)::int as n from waitlist where ip_hash = $1 and created_at > now() - interval '1 hour'", [ctx.ipHash]);
    if (recent.rows[0].n >= PER_IP_PER_HOUR) return fail("That's a lot of sign-ups from one place. Try again in an hour.");
  }
  const today = await pool.query("select count(*)::int as n from waitlist where created_at > now() - interval '1 day'");
  if (today.rows[0].n >= GLOBAL_PER_DAY) return fail("The list is unusually busy today. Please come back tomorrow — nothing is lost by waiting.");

  const email_norm = email.toLowerCase();
  const region_normalized = normalizeRegion(region);
  const ins = await pool.query(
    `insert into waitlist(waitlist_id, email, email_norm, first_name, region, region_normalized, gender, seeking, age_band, source, ip_hash, user_agent)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (email_norm) do nothing returning waitlist_id`,
    [newId("wl"), email, email_norm, first_name || null, region, region_normalized, gender, seeking, age_band, ctx.source ?? null, ctx.ipHash, ctx.userAgent?.slice(0, 300) ?? null]);
  const already = ins.rowCount === 0;
  const n = await pool.query("select count(*)::int as n from waitlist where region_normalized = $1 and status = 'waiting'", [region_normalized]);
  return { ok: true, first_name: first_name || null, region, waiting_in_region: n.rows[0].n, already };
}

/** Public, aggregate only: regions with enough people waiting to say so without pointing at anyone. */
export async function waitlistPublicSummary(minPerRegion = 3): Promise<{ total: number; regions: { region: string; waiting: number }[] }> {
  const total = await pool.query("select count(*)::int as n from waitlist where status = 'waiting'");
  const regions = await pool.query(
    `select min(region) as region, count(*)::int as waiting from waitlist where status = 'waiting' group by region_normalized having count(*) >= $1 order by waiting desc, region limit 12`, [minPerRegion]);
  return { total: total.rows[0].n, regions: regions.rows };
}

export async function waitlistAdminView() {
  const summary = await pool.query("select region_normalized, min(region) as region, count(*)::int as waiting, min(created_at) as first_at, max(created_at) as last_at from waitlist where status = 'waiting' group by region_normalized order by waiting desc");
  const rows = await pool.query("select waitlist_id, email, first_name, region, gender, seeking, age_band, source, status, created_at, notified_at from waitlist order by created_at desc limit 500");
  return { total: rows.rowCount, by_region: summary.rows, entries: rows.rows };
}

export async function removeFromWaitlist(id: string): Promise<boolean> {
  // A deletion request removes the person entirely: unpaid interviews and their transcripts go with the entry.
  await pool.query("delete from interviews where status <> 'paid' and waitlist_id in (select waitlist_id from waitlist where waitlist_id = $1 or email_norm = lower($1))", [id]);
  const r = await pool.query("delete from waitlist where waitlist_id = $1 or email_norm = lower($1)", [id]);
  return (r.rowCount ?? 0) > 0;
}
