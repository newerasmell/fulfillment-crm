# Prompts to paste into Claude Code, one phase at a time

Start every phase in a fresh session. Wait for the phase to be demoed and merged before the next one.
Fill the [brackets] first.

---

## Phase 0 — Foundation
```
Read CLAUDE.md, docs/SPEC.md and docs/PROGRESS.md. Start Phase 0.
Set up the monorepo with the stack from CLAUDE.md: Next.js web, separate worker, Prisma + Postgres
(pgvector), pg-boss, Auth.js with email+password and TOTP 2FA, RBAC roles from SPEC §3, accounts and
memberships with account switcher, encrypted credentials vault, audit log, i18n (bg default, en).
Create the full Prisma schema from SPEC §3 now (tables for later phases can stay unused).
Add a repository layer that enforces accountId scoping plus Postgres RLS, with an isolation test.
Add render.yaml for web + worker + Postgres. Plan first, show me the plan, then build.
```

## Phase 1 — Shopify
```
Phase 1 per SPEC §4. Use the Shopify GraphQL Admin API (pin the latest stable version in config).
Auth: Dev Dashboard app + client credentials grant, token refresh every 24h; check Shopify's current
docs before coding the auth flow and tell me if anything differs from SPEC §4.
Build: store connection screen, webhook registration + HMAC verification + WebhookEvent dedupe,
15-min reconcile, backfill N days, order/line/customer import, product+variant import, variant↔product
auto-match on SKU (with configurable prefix stripping) and a matching work queue.
First store to connect: [store domain].
```

## Phase 2 — FHB v3 adapter (production, staged)
```
Phase 2. Read docs/integrations/INTEGRATION_NOTES.md §1–2 and docs/integrations/fhb-kika-v3.md fully.
Generate Zod schemas from docs/integrations/raw/fhb-kika-v3.openapi.json, then build the FhbV3Adapter
per SPEC §5: login/token cache, products (incl. multi-products), orders create/update/delete/read/history,
order + stock callbacks with secret-path tokens, stock, movements, stock receipts, rma, cod, parcel
services, delivery points. Status mapping from §2.4 with UNKNOWN fallback.
Identifiers: product id = SKU with connection prefix [R]; order id = {STORECODE}-{number};
variable_symbol from a per-connection numeric sequence.
We use PRODUCTION only (no sandbox). Implement the liveMode gate from INTEGRATION_NOTES §6 in the
outbox sender first. Start the connection in READ_ONLY: mirror products, stock, order history, receipts,
RMA, COD, parcel services; record PII-scrubbed fixtures from those real responses; build the read-only
live check. Then DRY_RUN: build real payloads for real orders and show them, send nothing.
Tests: unit with fixtures + duplicate-submit test (mocked timeout after vendor accepted).
Do not send any POST/PUT/DELETE to FHB until I raise the mode. Then the FHB mirror screens (SPEC §6.7).
```

## Phase 3 — euShipments adapter (production, staged)
```
Phase 3. Read INTEGRATION_NOTES §1 and §4 and docs/integrations/eushipments.md fully.
Build the EuShipmentsAdapter: companies, couriers, warehouses, countries/cities/offices, products,
get-prod-avails, create-order, orders-history polling (batches of 100, cadence from settings),
delete, attach PDF, booking requests + both status services, transfers (dry-run with testMode).
Phone normaliser per §4.4 with a full test table; Σ(price×qty)=COD rule; truncation warnings;
office delivery by officeId only; status map §4.5 incl. BLOCKED and RETURN_RECEIVED alerts.
PRODUCTION only, same liveMode gate. READ_ONLY first (companies, couriers, warehouses, products,
availability, orders-history), then DRY_RUN using create-order with testMode: true. Then mirror screens.
```

## Phase 4 — Review queue and one-click Fulfill
```
Phase 4 per SPEC §6.1 and INTEGRATION_NOTES §5–6, including the CANARY confirmation dialog and daily cap. Build validators (hard/soft, bg+en messages, suggested
fixes), routing rules engine + admin UI, the Orders list with saved views and bulk Fulfill, the order
detail page with editable normalised address, Review records with field-level diffs and reason codes,
outbox sender with progress UI, Shopify fulfillment write-back with tracking, Alerts for BLOCKED/UNKNOWN.
Default routing to start with: [e.g. HR → euShipments; CZ/HU/PL/SK/SI → FHB].
```

## Phase 5 — Stock and inbound
```
Phase 5 per SPEC §6.3–6.4: stock board (physical/free/reserved/sellable/Shopify qty, snapshot age),
FHB push + reconcile, euShipments polling, discrepancy alerts, inbound creation from product picker or
XLSX/CSV upload (SKU, qty), expected vs received tracking, discrepancy tasks, optional Shopify inventory
push with per-store buffer and dry-run preview.
```

## Phase 6 — Returns and COD
```
Phase 6 per SPEC §6.5: returns board (FHB rma/list + return/list if active; euShipments 34/42/36),
"returning but not received after N days" view, RETURN_RECEIVED notification to support, COD board and
ageing report for both vendors.
```

## Phase 7 — Manual shipments and labels
```
Phase 7 per SPEC §6.6: manual shipment form (warehouse stock or label-only), FhbJoyAdapter
(INTEGRATION_NOTES §3: id placement rule, psc vs zip, 5-day reprint, 100-label bulk, reject only in printed),
euShipments createAWB/preAWB/price quote/print. Same validators and tracking pipeline.
```

## Phase 8 — AI
```
Phase 8 per SPEC §7. Decision capture already exists from phase 4 — verify it records diffs and reasons.
Build: embeddings for reviews (pgvector), AI reviewer with strict JSON tool output (model ids in config),
shadow mode metrics dashboard, AiPolicy levels L0–L2 with promotion/demotion rules and tests, daily audit
sample, kill switch, weekly rule-mining job that proposes validators for admin approval.
Use the current Anthropic SDK and check its docs for the tool-use / structured output API before coding.
```

## Phase 9 — API change watcher
```
Phase 9 per SPEC §8: daily fetch of the three vendor specs (URLs in SPEC §8) + Shopify version notes,
normalise, hash, diff, ApiSpecVersion history, Alert, regenerate docs via tools/render_docs.py, generate an
upgrade brief markdown listing affected adapters/schemas/tests. Daily read-only live checks. Simulate a
spec change in a test to prove the whole chain.
```

## Any time a vendor changes something
```
Run pnpm docs:refresh. Show me the diff of docs/integrations/raw/. For every change, update schemas,
mappers, validators, status maps, tests and INTEGRATION_NOTES.md, run pnpm check:live (read-only),
put affected connections in DRY_RUN until I confirm payloads, and log it in PROGRESS.md.
```
