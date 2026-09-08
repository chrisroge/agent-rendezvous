# Rendezvous readiness campaign and marketing rebuild

## Objective
Run a reproducible, isolated synthetic-community campaign that distinguishes service correctness from model judgment and does not mistake synthetic attraction or payment decisions for human demand. Rebuild the public homepage as a separate reviewable deliverable. Do not deploy changes to production during the campaign.

## Execution plan
1. Isolation: loopback staging application, dedicated disposable PostgreSQL database, new operator credential, captured mail, disabled ambassador and June. Refuse live Stripe keys or remote network destinations in staging. Keep credentials and transcripts out of git.
2. Close blockers: authenticated representation labels, explicit shareable dossier facts, terminal contact deletion, retryable notifications, fair representative scheduling, serialized background cycles and interview turns. Exercise negative cases rather than just happy paths.
3. Rehearsal: protocol suite plus hosted interview/representation, consent, mail failure/retry, spoofing, privacy, duplicate/concurrent requests, and payment fixtures. Real Stripe sandbox payment checks are separate and require a test key; mocked events are never reported as real transactions.
4. Community: 200 fictional people, dense/sparse/unbalanced regions (100/60/40), 30 logical days, deterministic seed. Registration/discovery/conversations/recommendations/consent use the actual MCP service. Simulated schedules, payment decisions and human consent are explicitly assumptions. Database fixture time shifts exercise expiries without claiming a real-time soak test.
5. Judgment: bounded real-model paired investigations against hidden incompatibility cases and an eligibility-only baseline. Stop at explicit call/token limits. Do not send private canary facts to counterpart agents. Measure results against independent fixture truth, not an LLM judge alone.
6. Evidence: machine-readable results, timelines, aggregate funnel, per-region opportunity, safety checks, model usage and a standalone interactive report. Document unsupported scenarios and remaining blockers honestly.
7. Marketing: new responsive editorial homepage, one early-access primary CTA, agent connection secondary; accurate availability/prices, example briefing clearly fictional, consent explanation, FAQ and no fabricated testimonials. Browser-check mobile/desktop and routes.

## Release gates
- Zero unauthorized contact reveals and representative impersonations.
- Contacts deleted across network and hosted copies after decline/expiry.
- Retry recovery and fair scheduler work selection demonstrated.
- No production data, real payments or external mail touched.
- Model screening measured separately from scripted community mechanics.
- Payment sandbox and real-time soak status explicitly reported; neither inferred from fixture tests.

## Stripe
Live and testing can operate concurrently. Stage uses its own test key, test prices and webhook signing secret; production retains live configuration. Prefer a Stripe sandbox for stronger settings isolation. Never load-test Stripe: use a handful of provider transactions and local signed fixtures for the large campaign.
