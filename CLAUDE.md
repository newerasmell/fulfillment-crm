# Fulfillment CRM — instructions for Claude Code

Internal multi-company CRM: Shopify orders in → human/AI review → one-click fulfilment to external
warehouses (FHB Group, euShipments) → tracking, stock, inbound, returns, COD back in.

## Read first, every session
1. `docs/SPEC.md` — what we are building, data model, workflows, phases. Work phase by phase.
2. `docs/integrations/INTEGRATION_NOTES.md` — mandatory before writing or changing any adapter.
3. Full vendor references when you need exact fields: `docs/integrations/fhb-kika-v3.md`,
   `fhb-joy.md`, `eushipments.md`; untouched originals in `docs/integrations/raw/`.
   If the notes and a reference disagree, the reference (raw spec) wins — then fix the notes.
4. `docs/PROGRESS.md` — what is done, what is next, decisions taken. Update it at the end of every task.
5. `docs/DESIGN.md` — UI principles, tokens and key screens. Every UI task follows it.
6. `docs/BACKLOG.md` — the ordered task list. Work only on the task you were given; mark it `[x]` when done,
   `[!]` with a reason when blocked. Never edit GATE lines. Unattended runs: see `docs/AUTONOMY.md`.

## Stack (do not change without asking)
TypeScript strict · Next.js (App Router) web · separate Node worker · PostgreSQL + pgvector · Prisma ·
pg-boss queues/cron · Zod at every boundary · Auth.js + TOTP · Tailwind + shadcn/ui + TanStack Table ·
Vitest + Playwright · pino · deploy on Render (web, worker, Postgres).

## Layout
```
src/app/                 Next.js routes (UI + API + /webhooks/*)
src/server/              domain services, repositories (always scoped by accountId)
src/integrations/shopify/
src/integrations/fhb-v3/ | fhb-joy/ | eushipments/
   client.ts  schemas.ts  mapper.ts  validators.ts  status-map.ts  adapter.ts  __fixtures__/  *.test.ts
src/worker/              queue handlers, pollers, cron
src/ai/                  reviewer, retrieval, policies, rule mining
prisma/                  schema + migrations
tools/                   render_docs.py, fetch_specs.sh (vendor doc refresh)
```

## Non-negotiable rules
- **Never create a duplicate shipment.** Deterministic external ids; on timeout/5xx read back by id before
  any retry; outbox table for every vendor write; idempotent handlers everywhere. Vendors do not always
  enforce uniqueness themselves (euShipments `referenceNumber` is not enforced) — our DB constraint and
  read-back are the guarantee. Where no read-back exists (euShipments booking requests), never auto-retry:
  mark UNCERTAIN and create an operator task.
- **Every query is scoped by `accountId`.** No exceptions; add a test when you add a repository.
- **Validate before sending.** Pre-flight validators per vendor (INTEGRATION_NOTES §5). A vendor 400 in
  production is a bug in our validators — add the missing rule + a test.
- Zod-parse every vendor response; unknown enum/status values are stored raw, mapped to UNKNOWN and
  alerted, never thrown.
- Never overwrite the FHB product EAN from our data. EAN is never a join key anywhere.
- COD and declared value go to vendors in the destination country's local currency.
- Credentials: encrypted at rest, never logged, never sent to the browser after save.
- No vendor call from React components or route handlers directly — go through services → outbox → worker.
- **We run against real production APIs only (no vendor sandboxes).** Every connection has a
  `liveMode`: READ_ONLY → DRY_RUN → CANARY → LIVE (see INTEGRATION_NOTES §6). New connections start in
  READ_ONLY. Only an OWNER can raise the mode; every change is audit-logged. Code must check the mode in
  the outbox sender, not in the UI.
- Automated tests and CI never call vendor APIs. They use recorded fixtures and mocks. Live checks are
  read-only (GET/list calls) except euShipments calls with `testMode: true` where noted.
- AI never cancels, deletes, changes COD or recipient identity; it only fills Review records unless an
  `AiPolicy` at L2 allows auto-approval.
- Do not invent vendor fields or endpoints. If something is not in the references, say so and stop.

## No real business data in git (the repo is public)
- Never commit real company, store, customer, product or account data: no company/store names, vendor
  account or company ids, SKUs, EANs, stock, order or COD numbers, screenshots, logs or exports from
  production. Use placeholders in docs and synthetic data in tests and fixtures.
- Real values live only in the deployed CRM (database, entered through the UI at the GATEs) and in Render
  environment variables. If a task seems to need a real value in the repo, mark it `[!]` instead.

## Unattended runs
- You may be running headless with nobody watching. Never wait for input and never ask questions:
  decide using the docs, or mark the task `[!]` with the exact question and stop.
- The build environment has no production credentials by design. Never try to obtain or use them.
- Use the `auditor` subagent before every commit; fix CRITICAL/HIGH findings first.

## Working style
- Small vertical slices with tests; run `pnpm typecheck && pnpm test` before saying a task is done.
- Each adapter gets: unit tests with recorded fixtures (PII scrubbed), a **read-only** live check
  (`pnpm check:live`, GET/list endpoints against production, schema-validates every response), and a
  duplicate-submit test (mocked). Fixtures are recorded from real production read calls.
- UI copy in Bulgarian and English (i18n keys), Bulgarian default.
- When a vendor spec changes: run `tools/fetch_specs.sh`, read the diff, update schemas/mappers/tests and
  INTEGRATION_NOTES, record the change in PROGRESS.md.
- Ask before: adding a new dependency category, changing the data model of an existing table with data,
  or anything that touches production credentials.

## Commands (create these in phase 0)
`pnpm dev` · `pnpm worker` · `pnpm db:migrate` · `pnpm test` · `pnpm check:live` · `pnpm typecheck` ·
`pnpm lint` · `pnpm docs:refresh` (runs tools/fetch_specs.sh)
