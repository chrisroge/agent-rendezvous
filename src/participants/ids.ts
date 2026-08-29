import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

function base32(bytes: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Random, non-sequential identifiers: 128 bits of entropy → enumeration-resistant. */
export function newId(prefix: string): string {
  return `${prefix}_${base32(randomBytes(16))}`;
}

export function newSecret(): string {
  return `rv_live_${randomBytes(32).toString("base64url")}`;
}

/** Secrets are 256-bit random strings, so a plain SHA-256 at rest is sufficient (no need for a slow KDF). */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
