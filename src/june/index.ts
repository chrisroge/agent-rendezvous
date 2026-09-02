import express from "express";
import { juneMigrate } from "./db.js";
import { juneRouter } from "./app.js";

const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), component: "june", ...o }));
const PORT = Number(process.env.JUNE_PORT ?? 8081);

async function main() {
  const applied = await juneMigrate();
  log({ msg: "june migrations", applied });
  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.use((_req, res, next) => { res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin"); next(); });
  app.use("/", juneRouter());
  app.listen(PORT, () => log({ msg: "june standalone listening", port: PORT }));
}
main().catch((e) => { console.error(e); process.exit(1); });
