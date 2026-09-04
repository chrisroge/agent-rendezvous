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

/** Published prices. Numbers only; every sentence that quotes a price derives from here. */
const pricing = {
  seekerMonthlyUsd: int("PRICE_SEEKER_MONTHLY_USD", 39),
  includedOpensPerMonth: int("PRICE_INCLUDED_OPENS", 12),
  packOpens: int("PRICE_PACK_OPENS", 5),
  packUsd: int("PRICE_PACK_USD", 10),
  chosenOneTimeUsd: int("PRICE_CHOSEN_ONE_TIME_USD", 29),
  founderMonthlyUsd: 5, // the original founding price; existing founding members keep it
};

export const config = {
  port: int("PORT", 8080),
  publicUrl: str("PUBLIC_URL", "https://agentrendezvous.app"),
  operatorToken: str("OPERATOR_TOKEN", ""),
  stripeSecretKey: str("STRIPE_SECRET_KEY", ""),
  stripeWebhookSecret: str("STRIPE_WEBHOOK_SECRET", ""),
  stripePriceId: str("STRIPE_PRICE_ID", ""),
  stripeFounderPriceId: str("STRIPE_FOUNDER_PRICE_ID", "") || str("STRIPE_PRICE_ID", ""), // empty (CFN default) falls back to the current price
  stripePortalConfigId: str("STRIPE_PORTAL_CONFIG_ID", ""),
  stripeRepresentedPriceId: str("STRIPE_REPRESENTED_PRICE_ID", ""), // one-time be-found price
  paymentLinkUrl: str("PAYMENT_LINK_URL", ""), // Stripe Payment Link for the current seeker price; must match pricing.seekerMonthlyUsd
  ambassador: {
    enabled: str("AMBASSADOR_ENABLED", "false") === "true",
    autoComments: str("AMBASSADOR_AUTO_COMMENTS", "false") === "true",
    anthropicApiKey: str("ANTHROPIC_API_KEY", ""),
    intervalMinutes: int("AMBASSADOR_INTERVAL_MINUTES", 180),
  },
  mail: {
    from: str("MAIL_FROM", ""),                       // e.g. "Rendezvous <matchmaker@agentrendezvous.app>"; empty = mail disabled
    replyTo: str("MAIL_REPLY_TO", "privacy@agentrendezvous.app"),
    region: str("MAIL_REGION", str("AWS_REGION", "us-east-2")),
    transport: str("MAIL_TRANSPORT", "ses") as "ses" | "smtp", // smtp = any relay with reputation (Resend, Postmark, …); creds from the rendezvous/smtp secret
    smtp: { host: str("MAIL_SMTP_HOST", ""), port: int("MAIL_SMTP_PORT", 587), user: str("MAIL_SMTP_USER", ""), pass: str("MAIL_SMTP_PASS", "") },
  },
  interview: {
    model: str("INTERVIEW_MODEL", "claude-sonnet-5"),
    matchmakerName: str("MATCHMAKER_NAME", ""),       // empty = "your matchmaker"
    maxTurns: int("INTERVIEW_MAX_TURNS", 40),
    dailyTurnCap: int("INTERVIEW_DAILY_TURN_CAP", 300),
    linkDays: int("INTERVIEW_LINK_DAYS", 14),
  },
  representative: {
    enabled: str("REPRESENTATIVE_ENABLED", "false") === "true",
    intervalMinutes: int("REPRESENTATIVE_INTERVAL_MINUTES", 60),
    networkUrl: str("REPRESENTATIVE_NETWORK_URL", `${str("PUBLIC_URL", "https://agentrendezvous.app")}/mcp`),
    maxModelCallsPerCycle: int("REPRESENTATIVE_MAX_CALLS_PER_CYCLE", 12),
    dailyModelCallCap: int("REPRESENTATIVE_DAILY_CALL_CAP", 200),
    maxRepliesPerRendezvous: int("REPRESENTATIVE_MAX_REPLIES", 8),
  },
  june: {
    enabled: str("JUNE_ENABLED", "false") === "true",
    schedulerEnabled: str("JUNE_SCHEDULER_ENABLED", "false") === "true",
    path: str("JUNE_PATH", "/meet"),
    cycleMinutes: int("JUNE_CYCLE_MINUTES", 180),
  },
  pricing,
  membership: {
    priceText: `${pricing.seekerMonthlyUsd}/month`,
    invitationExpiryDays: int("INVITATION_EXPIRY_DAYS", 7),
    invitationsInboundMax: int("INVITATIONS_INBOUND_MAX", 5),
    invitationsPendingMax: int("INVITATIONS_PENDING_MAX", 10),
  },
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
    introductionWindowDays: int("INTRODUCTION_WINDOW_DAYS", 14),
    establishedActiveDays: int("ESTABLISHED_ACTIVE_DAYS", 5),
    establishedCompletedRendezvous: int("ESTABLISHED_COMPLETED_RVZ", 3),
    requestBodyLimit: str("REQUEST_BODY_LIMIT", "64kb"),
  },
  protocolVersion: "RAP/0.3",
};

export type Config = typeof config;

/** Helper used by the HTTP layer. */
export function requestBodyLimit(): string { return config.limits.requestBodyLimit; }
