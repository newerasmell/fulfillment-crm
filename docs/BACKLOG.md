# Backlog — worked top to bottom by the autopilot

Markers: `[ ]` open · `[x]` done · `[!]` blocked (reason on the next line) · `GATE` = needs the owner; the
autopilot stops there and notifies. Task ids `P<phase>-<nn>`. The autopilot may split a task that is too big
into `P<phase>-<nn>a/b/c` lines directly below it, but never deletes or reorders tasks and never edits a GATE.
Every task: tests written, `pnpm typecheck && pnpm lint && pnpm test` green, auditor PASS, PROGRESS.md updated.

## Phase 0 — Foundation
- [x] P0-01 Monorepo scaffold: pnpm, Next.js (App Router, TS strict) in `src/app`, worker entry `src/worker`, ESLint, Prettier, Vitest, Playwright, pino; scripts from CLAUDE.md (`dev`, `worker`, `db:migrate`, `test`, `typecheck`, `lint`, `check:live`, `docs:refresh`). Acceptance: all scripts run green on an empty app.
- [x] P0-02 docker-compose for local dev/test Postgres 16 + pgvector; `.env.example` (no real secrets); test DB reset helper. Acceptance: `pnpm test` creates and migrates a throwaway DB.
- [x] P0-03 Prisma schema for the full domain model of SPEC §3 (all tables, enums incl. liveMode, CRM statuses). Acceptance: migration applies; ERD comment in schema.
- [x] P0-04 Repository layer with mandatory accountId scoping + Postgres RLS policies. Acceptance: isolation test proves account A cannot read/write account B data through any repository.
- [x] P0-05 Auth.js email+password, TOTP 2FA, sessions, rate-limited login. Acceptance: e2e login with 2FA.
- [x] P0-06 Accounts, memberships, roles (OWNER/ADMIN/OPERATOR/WAREHOUSE/VIEWER), account switcher, RBAC guard helpers. Acceptance: role matrix tests.
- [x] P0-07 Credentials vault (AES-256-GCM, key from env), write-only UI fields, masking in logs. Acceptance: secrets never appear in API responses or logs (test).
- [x] P0-08 Audit log service + UI list. Acceptance: every mutation in later code can call it; tested.
- [x] P0-09 pg-boss worker with queues, cron registration, retry/backoff, dead-letter view. Acceptance: sample job runs, retries, dead-letters.
- [x] P0-10 Outbox (`OutboundRequest`) + sender skeleton with the **liveMode gate** (READ_ONLY/DRY_RUN/CANARY/LIVE) and global kill switch. Acceptance: tests prove writes are refused in READ_ONLY, recorded-not-sent in DRY_RUN, require confirmation + daily cap in CANARY.
- [x] P0-11 i18n (bg default, en), base layout, navigation and design tokens exactly per docs/DESIGN.md (grouped sidebar per DESIGN.md Navigation, account switcher, header with Ctrl K search, warehouse scope control, "+ Създай" menu, alerts); Orders/Products/Stock/Warehouses/Settings empty pages. Acceptance: Playwright smoke + screenshots committed to docs/screens/.
- [x] P0-12 `render.yaml` (web, worker, Postgres) + health endpoints. Acceptance: config validates; no deploy performed.
- [x] P0-13 Group → companies (owner decision 2026-11-02): Account = business group (tenant), Company = legal entity inside it with archive instead of delete; stores/connections/orders belong to a company, products and stock to the group; members can be limited to companies (MembershipCompany, also via invitations); sidebar company filter. Acceptance: additive migration tested on a populated DB; scope/permission tests; e2e.
- [ ] GATE P0-G1 Owner: in the existing Render account create NEW services from render.yaml (Blueprint; do not touch any existing service), set env vars and CREDENTIALS_KEY, create the first OWNER user, add accounts (companies).

## Phase 1 — Shopify
- [x] P1-01 Shopify GraphQL client: pinned API version in config, cost-based throttling, retries, Zod for used queries; client-credentials token fetch + 24h refresh (verify current Shopify docs first, record findings in PROGRESS.md).
- [x] P1-02 Store connection screen + per-store settings (code, currency, countries, write-back mode, inventory push mode).
- [x] P1-03 Webhooks endpoint: HMAC verification, WebhookEvent dedupe, idempotent processing; registration job for the topics in SPEC §4.
- [x] P1-04 Order import (orders, lines, customer, addresses original+normalised, payment method/COD, risk, tags, notes) + 15-min reconcile + backfill N days.
- [x] P1-05 Product/variant import + Product master + StoreVariantLink auto-match on SKU with per-store prefix stripping; unmatched work queue UI.
- [x] P1-06 Orders list (filters, saved views) and order detail (read-only for now), plus the Начало dashboard skeleton per docs/DESIGN.md screen 1 (attention cards and today KPIs from CRM data). Acceptance: fixture-based e2e.
- [ ] GATE P1-G1 Owner: create the Dev Dashboard app, install on stores, enter client id/secret per store in the CRM, confirm stores are in the same Shopify organisation.

## Phase 2 — FHB v3 (production, READ_ONLY → DRY_RUN)
- [x] P2-01 Zod schemas generated from `docs/integrations/raw/fhb-kika-v3.openapi.json`; FHB client (login, base64 token header, token cache, 401 re-login, backoff). Unit tests with doc examples as fixtures.
- [x] P2-02 Read side: products (paged 250), stock/all, stock/movements, order/history, order read, rma/list, return/list, cod/list, parcel-service, delivery-point. Mirror tables + sync jobs.
- [x] P2-03 `pnpm fixtures:record` command: runs the read side against a configured connection and saves responses to `__fixtures__/` with PII **and business data** replaced by synthetic values (names, addresses, phones, emails, product names, SKUs, EANs, quantities, amounts, account/company ids); a test fails if a fixture contains a value not produced by the scrubber. (Built here, run by the owner at the gate.)
- [x] P2-04 Status map (INTEGRATION_NOTES §2.4) with raw storage, UNKNOWN + alert.
- [x] P2-05 Write side behind the outbox: product create/update (never overwrite EAN), multi-products, order create (ids, variable-symbol sequence, local-currency COD, `validate: true`, signed notification URLs), order update/delete only in `pending`, stock receipts. Duplicate-submit test with mocked timeout.
- [x] P2-06 Callback endpoints (order events, stock notify_url) with secret-path tokens, re-read on every event.
- [x] P2-07 FHB validators (INTEGRATION_NOTES §5) with bg/en messages.
- [x] P2-08 Mirror screens for FHB (SPEC §6.7, docs/DESIGN.md screen 4) + DRY_RUN payload preview. If docs/reference-screens/fhb/ has screenshots, every field/action shown there must be covered; list gaps in PROGRESS.md.
- [ ] GATE P2-G1 Owner: enter FHB + Joy production credentials (connection stays READ_ONLY), run `pnpm fixtures:record` once, check the scrubbed fixtures, then commit them.
- [ ] P2-09 Update schemas/mappers to the recorded real responses; any difference from the docs logged in INTEGRATION_NOTES.

## Phase 3 — euShipments (production, READ_ONLY → DRY_RUN with testMode)
- [x] P3-01 Client (Bearer, explicit testMode), Zod schemas from the reference; per-item error handling inside HTTP 200.
- [x] P3-02 Read side: companies, couriers, warehouses, countries/cities/offices, get-products, get-prod-avails, orders-history (batches of 100), booking status, COD by reference. Mirror tables + pollers.
- [x] P3-03 Status map by STATUS text with normalisation (Cyrillic look-alikes, dashes) seeded from INTEGRATION_NOTES §4.5; BLOCKED / RETURN_RECEIVED alerts; time threshold for "Information received".
- [x] P3-04 Phone normaliser per country (§4.4) with full test table; address truncation warnings; Σ(price×qty)=COD rule.
- [x] P3-05 Write side behind the outbox: create-product (barcode-collision handling), create-order (DB-unique referenceNumber + orders-history read-back), delete, attach PDF right after create, booking request (no auto-retry → UNCERTAIN task), transfers with deterministic externalRef.
- [x] P3-06 Mirror screens for euShipments (docs/DESIGN.md) + DRY_RUN using `testMode: true`; same screenshot coverage check with docs/reference-screens/eushipments/.
- [ ] GATE P3-G1 Owner: enter euShipments token, map companies to accounts, confirm with euShipments that `testMode: true` on production creates nothing visible, run `pnpm fixtures:record`.
- [ ] P3-07 Update schemas/mappers to recorded responses.

## Phase 4 — Review queue and Fulfill
- [x] P4-01 Validator engine (hard/soft, suggested fixes) combining vendor validators.
- [x] P4-02 Routing rules engine + admin UI (store, country, payment, tags, stock) with explanation per order.
- [x] P4-03 Pipeline state machine (SPEC §6.1) with tests for every transition.
- [x] P4-04 Order detail per docs/DESIGN.md screen 2: editable normalised address with live validation, findings, timeline, raw payloads (admin).
- [x] P4-05 Review records: decision, field-level diff, reason codes, time spent (this is the AI training data).
- [x] P4-06 Single + bulk Fulfill through the outbox with progress UI; CANARY confirmation dialog + daily cap.
- [x] P4-07 Shopify fulfillment write-back with tracking (respects store write-back mode).
- [x] P4-08 Alerts/tasks UI: BLOCKED, UNKNOWN, stuck in status, submit failures; email/Telegram notifications.
- [x] P4-09 Manual warehouse choice: before sending, "Изпрати от" with stock per warehouse of the same product line, reason required, checks re-run for the chosen connection, approval bound to it; after sending, "Пренасочи" only once the old warehouse confirmed the cancellation (never two shipments). Audited.
- [ ] GATE P4-G1 Owner: review DRY_RUN results on real orders, switch one connection to CANARY, run canary orders, then LIVE.

## Phase 5 — Stock and inbound
- [x] P5-00 Product lines + master catalogue: each company in exactly one line (owner decision 2026-11-02); create master products from a chosen warehouse catalogue; match suggestions only within the line (SKU after prefix; barcode and name as hints only); Excel export/import of the mapping per line; coverage report (≥ 99% before LIVE); line filter on every screen; fallback warehouses only from the same line.
- [x] P5-01 Stock board (physical/free/reserved/sellable/Shopify qty, snapshot age) + discrepancy alerts.
- [x] P5-02 Inbound creation (product picker + XLSX/CSV upload) for FHB receipts and euShipments bookings; expected vs received; discrepancy tasks.
- [x] P5-03 Shopify inventory push with buffer and dry-run preview (disabled by default).

## Phase 6 — Returns and COD
- [x] P6-01 Returns board (FHB rma/list, return/list; euShipments RETURN_RECEIVED), "returning but not received after N days", support notification.
- [x] P6-02 COD board + ageing report for both vendors.

## Phase 7 — Manual shipments and labels
- [x] P7-01 FHB Joy adapter (INTEGRATION_NOTES §3) behind the outbox incl. label storage and bulk label PDF.
- [x] P7-02 euShipments AWB services (createAWB, preAWB, price, print, delete).
- [x] P7-03 Manual shipment form (warehouse stock or label-only) through the same validators and tracking.

## Phase 8 — AI
- [x] P8-01 Embeddings for reviews (pgvector) + similar-case retrieval.
- [x] P8-02 AI reviewer (Claude API, strict JSON tool output, model ids in config) filling Review suggestions; full prompt/response log. Check current Anthropic SDK docs first.
- [x] P8-03 AiPolicy L0–L2 with promotion/demotion rules, daily audit sample, kill switch; agreement dashboard.
- [x] P8-04 Weekly rule-mining job proposing validators for admin approval.
- [ ] GATE P8-G1 Owner: set ANTHROPIC_API_KEY for the app, decide which accounts start in shadow mode.

## Phase 9 — API change watcher
- [x] P9-01 Daily spec fetch + normalise + hash + diff + ApiSpecVersion history + alert + upgrade brief.
- [x] P9-02 Daily read-only live schema check in the deployed app; affected connections drop to DRY_RUN on breaking change.

## Phase 10 — Remaining screens (added 2026-11-03: they were in the menu but had no task)
- [x] P10-01 Товарителници: every shipment (FHB, euShipments, Joy, AWB) with status chips, delayed, tracking, search, CSV; header search.
- [x] P10-02 Тикети от склада: FHB ticket notifications stored per shipment, alert on new ticket, review with note, link to ZOE.
- [x] P10-03 Офиси, PUDO, потребители: searchable directory over the mirrored offices, pick-up points, couriers, cities, sender data.
- [x] P10-04 Справки: orders, shipments and rates, processing times, COD, review/AI, stock — aggregate, scoped, CSV.
- [x] P10-05 Фактури: per-order invoice fields from the FHB mirror; warehouse invoices stay in the vendor cabinets (no list API).
