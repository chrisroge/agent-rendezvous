# Campaign findings — September 5, 2026

## What ran

A private loopback stage with its own PostgreSQL database, captured email, disabled ambassador/June, new operator token and guards against live payments or production destinations. No production deployment or external mail send occurred.

- Population: 200 fictional people, regions 100/60/40.
- Duration: 30 logical days; database aging exercises expiry and activity-day continuity. This is not a 30-day wall-clock soak.
- Final community: 512 rendezvous opened; 256 concluded; 201 mutual agent recommendations; 69 synthetic people observed contact introductions; 129 withdrew under scripted patience rules.
- Established-history threshold reached by 86 participants.
- Unexpected community errors: 0. Safety violation counters: {"eligibility":0,"unauthorized_reads":0,"premature_contact":0,"retained_terminal_contacts":0}.
- Readiness checks: 12/12. Isolation guard scenarios: 6/6.

## Actual model evidence

The final diagnostic used 51 model calls on claude-sonnet-5; 157194 input and 23662 output tokens. This excludes earlier diagnostic trials, interview calls and subsequent briefing/attack probes. All earlier completed trial summaries are retained in results/summary.json; raw logs remain in .stage.

Six known-incompatible or insufficient-evidence pair trials all ended in NO_INTRODUCTION. Of two aligned pair trials, one produced MUTUAL_AFFINITY and one did not. That is evidence of useful screening on these fixtures and a possible conservatism/consistency problem, not an accuracy estimate. An eligibility-only baseline would nominate all eight pairs. No withheld canary appeared in the diagnostic transcripts.

Hosted interview: passed, 6 scripted human turns using the real interview model and human-selected sharing. Payment activation used an internal fixture, not Stripe.

Real-model affinity through model-written briefings, captured invitation links, two HTML-form consents and captured reveal emails: passed.

One hostile-counterparty probe: passed. The withheld fact was filtered out before model input; this checks the data boundary, not universal prompt-injection immunity.

## Defects found and changes made

- Client-name impersonation of a hosted representative: identity now comes from the paid interview relationship.
- Unapproved dossier facts entering investigations: facts default private and the human selects shareable facts in the interview interface.
- Hosted contacts surviving decline/expiry, including stale local writes: terminal cleanup and authoritative row locking now protect both copies.
- Failed email permanently blocking progress: briefing and outcome delivery retry; outcome timestamps follow successful capture/acceptance.
- Scheduler starvation after the first 25 customers and overlapping work: last-serviced ordering and a database execution lock.
- Concurrent duplicate opens: participant locks serialize capacity checks and pair creation.
- Unpaid one-time checkout being treated as paid: payment-status checks.
- Premature model YES: recommendation tool schema only permits YES after sufficient messages.
- Misleading public pricing and background-search claims: unimplemented pack offers removed from pilot copy; explicit withdrawal and agent setup explained.

The first model trial exposed premature YES. The second exposed a fixture bug: numeric test-region identifiers resembled phone numbers when repeated by the model. Alphabetic regions and explicit permission to discuss coarse geography corrected the fixture. A later community trial classified normal invitation-cap throttling as an unexpected error; the simulated agent now waits. The activity-day aging fixture also needed a two-statement transaction to avoid transient unique-key collisions. These failed trials were not silently counted as successes.

## Limits and remaining gates

Stripe provider transactions are BLOCKED pending a sandbox/test key in rendezvous/staging/stripe. Live Stripe can remain enabled; stage uses separate keys, prices and webhook settings. A guarded smoke test is prepared. No provider transaction or public webhook delivery is claimed here.

The 200-person community uses scripted representatives, one disclosed living-arrangement dimension, fixed orientation patterns and declared consent/payment/patience assumptions. Rich model judgment is tested only on the small diagnostic set. Rejection, consent, withdrawal and synthetic subscription rates are not market evidence. Server candidate ordering has randomness; saved event logs, rather than the seed alone, provide exact replay.

Still required before broad paid rollout: provider Checkout/webhook verification, actual mailbox delivery, a wall-clock soak/restart campaign, review of remaining billing reconciliation cases and dependency advisories, and a real-human pilot. The hosted fact-selection UI is implemented, but granular revocation cannot recall facts already disclosed. June is not enabled or certified by this campaign.

## Customer-facing rebuild

The homepage is rebuilt in src/web/home.ts with an early-access primary action, original café illustration, clearly fictional briefing, accurate AI/availability disclosures and responsive styling. Desktop/mobile browser checks passed. It is a local staging preview, not a production deployment.

## Review artifacts

- results/report.html: standalone interactive replay with day slider, participant timelines, regional opportunity, model transcripts and readiness checks.
- results/summary.json: final measurements and prior completed trial summaries.
- results/home-desktop.png and results/home-mobile.png: marketing screenshots.
- RUNBOOK.md: reproduction and Stripe setup.
