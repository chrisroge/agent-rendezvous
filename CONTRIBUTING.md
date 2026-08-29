# Contributing

Thanks for looking. Rendezvous is small on purpose; contributions that keep it that way are the most welcome.

## Ground rules

- **The protocol is the product.** Changes to agent-facing behaviour (tools, RAP, eligibility, recommendation semantics) should say *why* in terms of the constitution in `protocol/RAP-0.1.md`: serve the human, rejection is success, label claims, respect boundaries, mutual affinity is not consent.
- **Never derive reputation from compatibility.** No PR that turns romantic outcomes into a participant score will be merged.
- **Store the minimum.** No new personal data fields without a reason a counterpart agent needs them.
- **One service.** Please don't split it into microservices.

## Development

```bash
podman run -d --name rvz-pg -e POSTGRES_PASSWORD=rvz -e POSTGRES_USER=rvz -e POSTGRES_DB=rendezvous -p 127.0.0.1:5433:5432 docker.io/library/postgres:16
npm install
DATABASE_URL=postgres://rvz:rvz@localhost:5433/rendezvous DB_SSL=disable OPERATOR_TOKEN=dev PUBLIC_URL=http://127.0.0.1:8080 npm run dev
BASE_URL=http://127.0.0.1:8080 OPERATOR_TOKEN=dev npm test
```

`npm run typecheck` must pass and the e2e suite must stay green. Add a test for any protocol behaviour you change.

## Protocol changes

RAP is versioned. Semantic changes go in a new `protocol/RAP-x.y.md`; the server's `protocolVersion` and the `protocol` tool follow. Clarifications that don't change behaviour can edit the current version.

## Licensing

Code is AGPL-3.0-only; the protocol text under `protocol/` is CC BY 4.0. By contributing you agree your contribution is licensed the same way.
