# Running the isolated campaign

Prerequisites: Node 22+, Python 3, Podman, a local `rvz-pg` PostgreSQL container listening on 127.0.0.1:5433 with the README's development credentials. AWS read access is optional for real-model tests and required to load the stored model key. No production write access is needed.

1. `npm ci`
2. `npm run stage` creates `rendezvous_stage`, binds the service to 127.0.0.1:18080, generates a new operator token and captures email locally. Credentials are saved to `.stage/env.json` with mode 0600. Never publish that directory.
3. `python3 tools/stage.py run env BASE_URL=http://127.0.0.1:18080 npm test`
4. `python3 tools/stage.py run env ANTHROPIC_API_KEY= npx tsx tests/campaign/readiness.ts` and `node tests/campaign/isolation.cjs`.
5. `python3 tools/stage.py run env CAMPAIGN_PEOPLE=20 npx tsx tests/campaign/community.ts` for the rehearsal.
6. `npm run test:community` for 200 people and 30 logical days. Do not run two community campaigns simultaneously: expiry sweeping is global within the isolated database. A completed run writes `.stage/latest-community.txt` and its detailed event log.
7. `npm run test:interview` makes a real-model hosted interview (maximum six scripted human turns, up to five model calls each). `npm run test:judgment` runs eight paired real-model investigations with an 80-call cap. These consume model credits; model investigations record input/output token usage separately from the interview.
8. `npm run campaign:report` generates `docs/campaign/results/report.html`, a standalone interactive replay, and a summary JSON. The stage exposes the report at http://127.0.0.1:18080/campaign after it is generated.
9. `npx playwright install chromium`, then `node tests/campaign/browser.cjs` for desktop/mobile screenshots and interaction checks. `npm run typecheck:campaign` checks the application and harness together.

## Restart / stop

The stage is intentionally a private local process. Its PID is `.stage/server.pid`. Stop its process group with Python `os.killpg(pid, signal.SIGTERM)`; `npm run stage` starts it again. Stop before restarting after application edits. Keep the synthetic database for replay, or explicitly remove it once the artifacts are saved. The production deployment script is not used: it contains fixed production resource names.

## Stripe sandbox alongside live

The live site keeps `rendezvous/stripe` and its live prices/webhook. Put a separate sandbox/test key in Secrets Manager `rendezvous/staging/stripe`, JSON field `secret_key`. Do not replace the live secret. Test keys start `sk_test_` or `rk_test_`; stage refuses live keys.

Run `npm run stage` to import the test key, then `npm run test:stripe-sandbox -- --setup` (or `python3 tools/stage.py run npx tsx tests/campaign/stripe-sandbox.ts --setup`). This creates sandbox-only prices and a local forwarding signature. Restart stage. Run `npm run test:stripe-sandbox`.

The smoke test creates one real sandbox subscription using `pm_card_visa`, checks payment, forwards the actual provider event through the local signed webhook handler twice, verifies membership and duplicate suppression, then cancels the subscription and deletes the synthetic Stripe customer. It does not test browser Checkout completion or direct public webhook delivery. Use Stripe CLI forwarding or a separately authenticated HTTPS staging deployment to test direct delivery. Do not load-test Stripe with the community population.

Sources: https://docs.stripe.com/testing ; https://docs.stripe.com/keys ; https://docs.stripe.com/sandboxes . Test and live objects/credentials are separate. A sandbox is preferable for settings isolation; do not assume all legacy test-mode Dashboard settings are isolated from live mode.

## Interpreting the results

The community uses scripted human/agent decisions and synthetic application payment events. Its 30 days are logical steps with scoped database aging, not a real-time soak. Candidate ranking includes server randomness, so the saved event log is the exact replay; the population seed alone does not reproduce ordering. Failed model trials remain in `.stage/judgment-*`; retain them when interpreting prompt or fixture changes. Do not treat simulated consent, rejection or withdrawals as market evidence.
