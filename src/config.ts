import { readFileSync, existsSync } from "node:fs";

function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer for ${name}: ${v}`);
  return n;
}

function str(name: string, def: string): string {
  return process.env[name] ?? def;
}

/** Build a pg connection config from either DATABASE_URL or discrete DB_* variables. */
function dbConfig() {
  const url = process.env.DATABASE_URL;
  const sslMode = str("DB_SSL", url && url.includes("localhost") ? "disable" : "require");
  let ssl: false | { ca?: string; rejectUnauthorized: boolean } = false;
  if (sslMode !== "disable") {
    const caPath = str("DB_SSL_CA", "/app/rds-global-bundle.pem");
    if (existsSync(caPath)) {
      ssl = { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true };
    } else {
      // Fall back to encrypted-but-unverified only when no CA bundle is present (local dev).
      ssl = { rejectUnauthorized: false };
    }
  }
  if (url) return { connectionString: url, ssl };
  return {
    host: str("DB_HOST", "127.0.0.1"),
    port: int("DB_PORT", 5432),
    user: str("DB_USER", "rendezvous"),
    password: str("DB_PASSWORD", ""),
    database: str("DB_NAME", "rendezvous"),
    ssl,
  };
}

export const config = {
  port: int("PORT", 8080),
  publicUrl: str("PUBLIC_URL", "https://agentrendezvous.app"),
  operatorToken: str("OPERATOR_TOKEN", ""),
  stripeSecretKey: str("STRIPE_SECRET_KEY", ""),
  stripeWebhookSecret: str("STRIPE_WEBHOOK_SECRET", ""),
  db: dbConfig(),
  limits: {
    newMaxActiveRendezvous: int("NEW_MAX_ACTIVE_RVZ", 3),
    establishedMaxActiveRendezvous: int("EST_MAX_ACTIVE_RVZ", 10),
    newDiscoverPerDay: int("NEW_DISCOVER_PER_DAY", 10),
    establishedDiscoverPerDay: int("EST_DISCOVER_PER_DAY", 50),
    maxOpensPerDay: int("MAX_OPENS_PER_DAY", 10),
    maxSendsPerHour: int("MAX_SENDS_PER_HOUR", 60),
    maxMessageChars: int("MAX_MESSAGE_CHARS", 8000),
    maxMessagesPerRendezvous: int("MAX_MESSAGES_PER_RVZ", 200),
    maxConsecutiveMessages: int("MAX_CONSECUTIVE_MESSAGES", 3),
    minMessagesEachForYes: int("MIN_MESSAGES_EACH_FOR_YES", 3),
    screenMessagesEach: int("SCREEN_MESSAGES_EACH", 3),
    rendezvousExpiryDays: int("RVZ_EXPIRY_DAYS", 14),
    establishedActiveDays: int("ESTABLISHED_ACTIVE_DAYS", 5),
    establishedCompletedRendezvous: int("ESTABLISHED_COMPLETED_RVZ", 3),
    requestBodyLimit: str("REQUEST_BODY_LIMIT", "64kb"),
  },
  protocolVersion: "RAP/0.1",
};

export type Config = typeof config;

/** Helper used by the HTTP layer. */
export function requestBodyLimit(): string { return config.limits.requestBodyLimit; }
