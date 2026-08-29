import { E } from "../errors.js";

export const GENDERS = ["man", "woman", "nonbinary", "other"] as const;
export const RELATIONSHIP_INTENTS = ["long_term", "marriage", "life_partner", "companionship", "undecided"] as const;

export interface IntentInput {
  represented_gender: string;
  seeking_gender: string[] | string;
  represented_age_band?: string;   // e.g. "50-59"
  represented_age?: number;        // alternative; converted to a 5-year band and never stored exactly
  preferred_age_min?: number;
  preferred_age_max?: number;
  relationship_intent: string[] | string;
  region: string;
  radius_miles?: number;
  coarse_lat?: number;
  coarse_lon?: number;
  attributes?: string[];
  exclusions?: string[];
}

export interface Intent {
  participant_id: string;
  represented_gender: string;
  represented_age_min: number;
  represented_age_max: number;
  seeking_genders: string[];
  preferred_age_min: number;
  preferred_age_max: number;
  relationship_intent: string[];
  region: string;
  region_normalized: string;
  radius_miles: number;
  coarse_lat: number | null;
  coarse_lon: number | null;
  attributes: string[];
  exclusions: string[];
}

const TAG_RE = /^[a-z0-9_]{1,40}$/;

function normGender(g: string): string {
  const v = g.trim().toLowerCase().replace(/[\s-]+/g, "");
  const map: Record<string, string> = { man: "man", male: "man", men: "man", woman: "woman", female: "woman", women: "woman",
    nonbinary: "nonbinary", nb: "nonbinary", enby: "nonbinary", other: "other", any: "any", all: "any", everyone: "any" };
  const out = map[v];
  if (!out) throw E.invalid(`Unrecognised gender '${g}'. Use one of: ${GENDERS.join(", ")} (or 'any' when seeking).`);
  return out;
}

function normIntent(i: string): string {
  const v = i.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const map: Record<string, string> = { long_term: "long_term", long_term_relationship: "long_term", ltr: "long_term", serious: "long_term",
    marriage: "marriage", married: "marriage", life_partner: "life_partner", partner: "life_partner", companionship: "companionship",
    companion: "companionship", undecided: "undecided", open: "undecided", unsure: "undecided" };
  const out = map[v];
  if (!out) throw E.invalid(`Unrecognised relationship_intent '${i}'. Use one of: ${RELATIONSHIP_INTENTS.join(", ")}.`);
  return out;
}

export function normalizeRegion(r: string): string {
  return r.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function asList(v: string[] | string | undefined): string[] {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).map((s) => String(s));
}

export function normalizeIntent(input: IntentInput): Intent {
  const represented_gender = normGender(input.represented_gender);
  if (represented_gender === "any") throw E.invalid("represented_gender must be a specific gender.");
  const seekingRaw = asList(input.seeking_gender).map(normGender);
  if (seekingRaw.length === 0) throw E.invalid("seeking_gender is required.");
  const seeking_genders = seekingRaw.includes("any") ? [...GENDERS] : [...new Set(seekingRaw)];

  let ageMin: number, ageMax: number;
  if (input.represented_age_band) {
    const m = /^(\d{2})\s*[-–]\s*(\d{2})$/.exec(input.represented_age_band.trim());
    if (!m) throw E.invalid("represented_age_band must look like '45-49' or '50-59'.");
    ageMin = Number(m[1]); ageMax = Number(m[2]);
  } else if (typeof input.represented_age === "number") {
    const a = Math.floor(input.represented_age);
    ageMin = Math.floor(a / 5) * 5; ageMax = ageMin + 4;
  } else {
    throw E.invalid("Provide represented_age_band (e.g. '50-59') or represented_age.");
  }
  if (ageMin < 18 || ageMax < ageMin || ageMax > 120) throw E.invalid("Participants must represent adults (18+); check the age band.");

  const preferred_age_min = input.preferred_age_min ?? Math.max(18, ageMin - 10);
  const preferred_age_max = input.preferred_age_max ?? ageMax + 10;
  if (preferred_age_min < 18 || preferred_age_max < preferred_age_min || preferred_age_max > 120) {
    throw E.invalid("preferred_age_min/max must be >= 18 and min <= max.");
  }

  const relationship_intent = [...new Set(asList(input.relationship_intent).map(normIntent))];
  if (relationship_intent.length === 0) throw E.invalid("relationship_intent is required (e.g. ['long_term']).");

  const region = String(input.region ?? "").trim();
  if (region.length < 2 || region.length > 80) throw E.invalid("region must be a short human-readable area, e.g. 'South Florida'.");
  const region_normalized = normalizeRegion(region);

  const radius_miles = Math.min(Math.max(Math.floor(input.radius_miles ?? 50), 5), 3000);

  let coarse_lat: number | null = null, coarse_lon: number | null = null;
  if (typeof input.coarse_lat === "number" && typeof input.coarse_lon === "number") {
    if (Math.abs(input.coarse_lat) > 90 || Math.abs(input.coarse_lon) > 180) throw E.invalid("coarse_lat/coarse_lon out of range.");
    // Round to 0.1 degree (~7 miles) so exact locations are never stored.
    coarse_lat = Math.round(input.coarse_lat * 10) / 10;
    coarse_lon = Math.round(input.coarse_lon * 10) / 10;
  }

  const tags = (v: string[] | undefined, name: string) => {
    const out = [...new Set(asList(v).map((t) => t.trim().toLowerCase().replace(/[\s-]+/g, "_")))];
    if (out.length > 20) throw E.invalid(`${name}: at most 20 tags.`);
    for (const t of out) if (!TAG_RE.test(t)) throw E.invalid(`${name}: '${t}' must be a short snake_case tag.`);
    return out;
  };

  return {
    participant_id: "",
    represented_gender,
    represented_age_min: ageMin,
    represented_age_max: ageMax,
    seeking_genders,
    preferred_age_min,
    preferred_age_max,
    relationship_intent,
    region,
    region_normalized,
    radius_miles,
    coarse_lat,
    coarse_lon,
    attributes: tags(input.attributes, "attributes"),
    exclusions: tags(input.exclusions, "exclusions"),
  };
}

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function overlaps(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  return aMin <= bMax && bMin <= aMax;
}

function intersects(a: string[], b: string[]): boolean {
  return a.some((x) => b.includes(x));
}

/**
 * Deterministic, symmetric hard-eligibility test. Never explains *which* criterion failed.
 * Gender, age, relationship intent, geography and machine-testable exclusions only.
 */
export function mutuallyEligible(a: Intent, b: Intent): boolean {
  if (a.participant_id && a.participant_id === b.participant_id) return false;
  if (!a.seeking_genders.includes(b.represented_gender)) return false;
  if (!b.seeking_genders.includes(a.represented_gender)) return false;
  if (!overlaps(a.preferred_age_min, a.preferred_age_max, b.represented_age_min, b.represented_age_max)) return false;
  if (!overlaps(b.preferred_age_min, b.preferred_age_max, a.represented_age_min, a.represented_age_max)) return false;
  if (!intersects(a.relationship_intent, b.relationship_intent)) return false;
  if (intersects(a.exclusions, b.attributes)) return false;
  if (intersects(b.exclusions, a.attributes)) return false;
  if (a.coarse_lat !== null && a.coarse_lon !== null && b.coarse_lat !== null && b.coarse_lon !== null) {
    const d = haversineMiles(a.coarse_lat, a.coarse_lon, b.coarse_lat, b.coarse_lon);
    if (d > a.radius_miles || d > b.radius_miles) return false;
  } else if (a.region_normalized !== b.region_normalized) {
    return false;
  }
  return true;
}

/** What a counterparty is allowed to learn about an intent: only the coarse routing facts. */
export function publicIntentView(i: Intent) {
  return {
    represented_gender: i.represented_gender,
    represented_age_band: `${i.represented_age_min}-${i.represented_age_max}`,
    relationship_intent: i.relationship_intent,
    region: i.region,
  };
}
