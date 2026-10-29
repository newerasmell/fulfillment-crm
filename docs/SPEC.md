# Fulfillment CRM — product & technical specification

Internal system for a group of companies that sell through many Shopify stores and fulfil through
external fulfillment centres (FHB Group and euShipments today, more later). One place to see every order,
check it, approve it, send it to the right warehouse with one click, and track it to delivery, return and
COD payout. A "clone" of each warehouse panel lives inside the CRM so nobody needs ZOE or the euShipments
cabinet for daily work.

Vendor details: `docs/integrations/INTEGRATION_NOTES.md` (rules) and the full references next to it.

---

## 1. Goals and non-goals

**Goals**
1. Multi-company: each company (legal entity) is an **Account** with its own stores, fulfillment
   connections, products, orders, users and settings. A user can belong to several accounts and switch.
2. All Shopify orders of every connected store flow in automatically, in near real time.
3. Operators review → approve → **Fulfill** (single or bulk). The order appears in the fulfillment
   system **without errors** because everything is validated beforehand, and tracking flows back to Shopify.
4. Mirror of each fulfillment system: products, real-time stock, inbound (stock receipts / booking
   requests), orders and statuses, returns, COD, carriers and pick-up points, labels.
5. Manual shipments (not from Shopify), product creation at the warehouses, stock/booking requests.
6. AI learns from the operators' decisions and progressively takes over routine approvals, with
   measurable accuracy gates and a kill switch.
7. Watches vendor API documentation for changes and prepares the upgrade work.

**Non-goals (v1)**: accounting/invoicing, ad management, customer-service ticketing (Gorgias stays),
storefront editing.

---

## 2. Architecture

```
            ┌─────────── Web app (Next.js, App Router, TypeScript) ───────────┐
 Operators ─┤  UI (React, Tailwind, shadcn/ui, TanStack Table)                │
            │  API routes / server actions  ─── auth, RBAC, audit             │
            └──────────────┬──────────────────────────────────────────────────┘
                           │ Prisma
                    ┌──────▼──────┐        ┌───────────────────────────────┐
                    │ PostgreSQL  │◄──────►│ Worker (Node, pg-boss queues)  │
                    │ (+pgvector) │        │ - Shopify sync & webhooks      │
                    └─────────────┘        │ - Outbox sender per vendor     │
                                           │ - Status pollers / reconcilers │
  Shopify webhooks ──► /webhooks/shopify   │ - Stock sync                   │
  FHB callbacks   ──► /webhooks/fhb        │ - AI review jobs               │
                                           │ - API-doc watcher (daily)      │
                                           └──────┬────────────────────────┘
                                                  │ adapters (one per vendor)
                         Shopify GraphQL Admin · FHB v3 · FHB Joy · euShipments
```

- **Stack**: TypeScript everywhere. Next.js 15+ (web + API), separate long-running worker process,
  PostgreSQL 16 with pgvector, Prisma, pg-boss for queues/cron (no Redis needed), Zod for every external
  payload, Auth.js (credentials + TOTP 2FA), Vitest + Playwright, pino logging.
- **Hosting**: Render (web service + background worker + managed Postgres). Public HTTPS is required for
  Shopify and FHB callbacks.
- **Adapters** implement a common interface (section 5) and live in `src/integrations/<vendor>/`
  with: `client.ts` (HTTP, auth, retries), `schemas.ts` (Zod, generated from the specs where possible),
  `mapper.ts` (CRM ↔ vendor), `validators.ts`, `status-map.ts`, `adapter.ts`, and recorded fixtures.
- **Secrets**: vendor credentials stored encrypted (AES-256-GCM, key in env `CREDENTIALS_KEY`), never
  returned to the browser after save, masked in logs.

---

## 3. Domain model (Prisma-level outline)

Every business table carries `accountId` and every query is scoped by it (enforced in a repository layer
+ Postgres row-level security as a second line of defence).

- **Account** — legal entity: name, legal details, default currency, timezone, settings JSON.
- **User**, **Membership**(user, account, role: OWNER | ADMIN | OPERATOR | WAREHOUSE | VIEWER).
- **Store** — Shopify shop: domain, code (short, unique per account, used in external ids), currency,
  markets/countries, credentials ref, webhook status, last sync cursors.
- **FulfillmentConnection** — one credential set at one vendor: type (FHB_V3 | FHB_JOY | EUSHIPMENTS),
  liveMode (READ_ONLY | DRY_RUN | CANARY | LIVE — production only, see INTEGRATION_NOTES §6), credentials ref, vendor-side ids (euShipments companyId/senderId,
  warehouseIds), SKU prefix rule, default sender, variable-symbol sequence, enabled features.
- **RoutingRule** — ordered rules choosing the connection + carrier for an order:
  match on store, country, payment method (COD/prepaid), tags, product set, stock availability; output
  connection, parcel service / courierId, service name, delivery-point policy.
- **CountrySetting** — country → currency, phone rules, default couriers per connection.
- **Product** (CRM master, per account) — internal SKU, name, brand, type, variant attributes
  (EDT/EDP/Parfum/Elixir/Intense/tester are distinct products), weight, dimensions, HS code, country of
  origin, images. **EANs**: list of known EANs with batch notes (never a join key).
- **StoreVariantLink** — Shopify variant (gid, SKU) ↔ Product. Auto-match on SKU after prefix stripping,
  fallback suggestions by title; unmatched variants show up in a work queue.
- **VendorProduct** — Product ↔ FulfillmentConnection: vendor id/refNumber, vendor internal code, vendor
  EAN (read-only mirror), archived, last sync, raw JSON.
- **StockLevel** — per VendorProduct: physical, free/available, CRM-reserved (approved-not-shipped),
  sellable = min(vendor free, physical − reserved), snapshot time, source (push | poll).
- **StockMovement** — mirror of vendor movements + our reservations.
- **InboundShipment** — FHB stock receipt / euShipments booking request: lines with expected vs received,
  status, tracking, discrepancy tasks.
- **Order** — from Shopify or manual: source, store, Shopify ids, number, customer, shipping address
  (original + normalised), billing, currency, totals, payment method, COD amount (order currency + local
  currency + rate used), tags, notes, risk, lines.
- **OrderLine** — variant, Product, qty, unit price after discounts.
- **Fulfillment** (a.k.a. shipment) — Order → connection: external id, variable symbol, vendor uid/orderId,
  carrier, delivery point, CRM status, raw vendor status, tracking numbers/links, events, label file,
  timestamps, COD status, return info. An order can have several (split / reship).
- **Review** — pre-flight results + human decision: validator findings, AI suggestion + confidence,
  decision (APPROVE | EDIT_AND_APPROVE | HOLD | CANCEL | REROUTE), field-level diff of edits, reason code,
  free-text reason, reviewer, time spent.
- **OutboundRequest** — outbox: connection, operation, idempotency key, payload, attempts, last response,
  status.
- **WebhookEvent** — inbound raw events (Shopify, FHB) with processing state (dedupe by id/hash).
- **Alert / Task** — blocked orders, unknown statuses, stock discrepancies, API changes, return received,
  COD overdue; assignee, SLA.
- **AuditLog** — who did what, before/after.
- **ApiSpecVersion** — vendor, source URL, fetched at, hash, normalised spec, diff vs previous.
- **AiPolicy** — per account + decision type: autonomy level, thresholds, enabled flag.

---

## 4. Shopify integration

- Apps: since 1 Jan 2026 new "legacy custom apps" cannot be created in the Shopify admin. Create **one app
  in the Shopify Dev Dashboard** under the organisation that owns the stores and install it on each store.
  Get tokens with the **client credentials grant** (works only when app and store are in the same
  organisation; tokens are short-lived, refresh every ~24h). Stores in another organisation need the
  authorization-code flow instead. Verify the current flow in Shopify docs at build time.
- Scopes (confirm against current docs): `read_orders`, `read_products`, `read_inventory`,
  `write_inventory`, `read_locations`, `read_merchant_managed_fulfillment_orders`,
  `write_merchant_managed_fulfillment_orders`, `read_fulfillments`, `write_fulfillments`, `read_customers`.
  Request **protected customer data** access (name, address, phone, email) in the app configuration,
  otherwise addresses come back empty.
- GraphQL Admin API only, pinned version (latest stable at build time) stored in config; the API-doc
  watcher flags upcoming version deprecations.
- Ingest: webhooks `orders/create`, `orders/updated`, `orders/cancelled`, `orders/edited`, `refunds/create`,
  `products/update`, `app/uninstalled`; HMAC-verified, stored in WebhookEvent, processed idempotently.
  Plus a reconcile job every 15 min (orders updated since cursor) and a manual "backfill N days".
- Write-back: on SHIPPED create the fulfillment on the order's FulfillmentOrders with tracking number,
  company and URL, notifying the customer per store setting. Cancellations in Shopify → if the vendor
  order is still cancellable, propose cancellation to the operator (never auto-cancel a shipped order).
- Inventory: optional per store — push sellable stock to the Shopify location that represents the
  warehouse (`inventorySetQuantities`), with a per-store safety buffer and a dry-run preview.

---

## 5. Fulfillment adapter interface

```ts
interface FulfillmentAdapter {
  capabilities: Capability[];                       // e.g. 'webhooks', 'pudo', 'bundles', 'labels', 'transfers'
  testConnection(): Promise<HealthResult>;
  // catalog
  listProducts(cursor?): AsyncIterable<VendorProductDTO>;
  upsertProduct(p: ProductDTO): Promise<VendorProductDTO>;
  archiveProduct(id: string): Promise<void>;
  // stock
  getStock(ids?: string[]): Promise<StockDTO[]>;
  listMovements(range): AsyncIterable<MovementDTO>;
  // orders
  validateOrder(o: OrderDTO): ValidationFinding[];  // pure, no network
  createOrder(o: OrderDTO): Promise<CreateResult>;  // idempotent via read-back
  updateOrder?(o: OrderDTO): Promise<void>;
  cancelOrder(externalId: string): Promise<CancelResult>;
  getOrder(externalId: string): Promise<VendorOrderDTO | null>;
  listOrderUpdates(since: Date): AsyncIterable<VendorOrderDTO>;
  // inbound, returns, cod, carriers, labels — optional per capability
}
```

Adapters: `FhbV3Adapter`, `FhbJoyAdapter` (manual parcels/labels), `EuShipmentsAdapter`.
Each adapter must pass its fixture-based test suite and the read-only live check, then move through the
production modes READ_ONLY → DRY_RUN → CANARY → LIVE (INTEGRATION_NOTES §6). There is no sandbox stage.

---

## 6. Core workflows

### 6.1 Order pipeline (CRM statuses)

```
IMPORTED → CHECKING → NEEDS_REVIEW ─┐
                    → READY ────────┤ (operator or AI policy approves)
                                    ▼
                               APPROVED → QUEUED → SUBMITTING → ACCEPTED → PROCESSING → SHIPPED
                                                       │                               │
                                                       ▼                               ├→ DELIVERED → (COD_PAID)
                                                  SUBMIT_FAILED (readable reason,       ├→ RETURNING → RETURN_RECEIVED
                                                  field highlighted, retry/edit)        └→ EXCEPTION
 side states: ON_HOLD, BLOCKED (vendor-side: stock/data), CANCELLED, UNKNOWN
```

- CHECKING runs: routing (which connection), product mapping, stock check, validators
  (INTEGRATION_NOTES §5), duplicate detection, AI review.
- Orders list = the main screen: filters by account, store, country, status, connection, flags; saved
  views (e.g. "Ready to fulfil – FHB", "Blocked", "Returns to confirm"); bulk select → **Fulfill**.
- Order detail: customer + address (original vs normalised, editable with live validation), lines with
  stock per warehouse, routing decision and why, findings, AI suggestion, timeline (Shopify, CRM, vendor
  events), raw payloads (admin only).
- Bulk fulfil: only orders with no hard blocks; progress view; per-order result; nothing partial-silent.

### 6.2 Products at the warehouses
Product master → "Create at warehouse" (single or bulk) per connection, preview of the exact payload,
SKU prefix applied, bundles as FHB multi-products. Sync back vendor code/EAN read-only. Work queue for
Shopify variants without a product and products without a vendor link.

### 6.3 Stock (real time)
Stock board: product × warehouse with physical, free, reserved, sellable, Shopify qty per store, snapshot
age. FHB: push via `notify_url` + reconcile every 30 min. euShipments: poll `get-prod-avails` every
15 min (configurable). Discrepancy alerts: Shopify sells more than sellable, vendor free drops without a
CRM order, negative sellable.

### 6.4 Inbound (stock requests / bookings)
Create FHB stock receipt or euShipments booking request from a product list or CSV/XLSX upload (columns:
SKU, qty). Track expected vs received/accepted per line; discrepancy → task with the warehouse comment.

### 6.5 Returns & COD
Returns: FHB `rma/list` (+ `return/list` if the service is active), euShipments statuses 34/42/36 →
RETURN_RECEIVED with date → notifies support that the refund can be processed. Board of "returning
but not yet received after N days". COD: per fulfillment `waiting/received/paid` (FHB) and euShipments
COD info; ageing report.

### 6.6 Manual shipments
"New shipment" form not tied to Shopify: pick account → connection → stock items (warehouse fulfils) **or**
label-only parcel via FHB Joy / euShipments AWB. Same validators, same tracking.

### 6.7 Warehouse mirror screens
For each connection, a section reproducing the vendor panel: Products, Stock + movements, Inbound,
Orders, Returns/RMA, COD, Carriers & pick-up points, Labels (Joy), Transfers (euShipments). Read from
the local mirror, actions go through the adapter.

---

## 7. AI: learn from operators, then act alone

Principle: **deterministic checks first, AI second, autonomy earned with data.**

1. **Decision capture** (from day one, before any AI): every Review stores the findings, the final
   decision, the field-level diff of what the operator changed (e.g. phone `06301234567` → `+36301234567`,
   street split into street + number), a reason code from a fixed list, optional comment, and time spent.
2. **AI reviewer** (Claude API, model id in config; start with `claude-sonnet-5-5`, use
   `claude-haiku-5-5` for cheap high-volume checks): input = normalised order + findings + customer
   history + the 20 most similar past reviews retrieved with pgvector (address/country/issue embedding).
   Output via strict JSON schema (tool use): `{decision, confidence 0–1, fixes[{field, from, to, reason}],
   flags[], explanation_bg}`. Never sends anything itself — it only fills the Review.
3. **Rule mining**: weekly job clusters repeated operator corrections and proposes new deterministic
   validators/auto-fixes (e.g. "HU phones starting 06 → +36"). An admin accepts/rejects each proposal;
   accepted ones become code-level rules with tests (via a Claude Code session).
4. **Autonomy levels** per account × decision type (`AiPolicy`):
   - L0 Shadow — AI suggests, humans decide; agreement rate measured.
   - L1 Assist — AI pre-applies fixes, human clicks approve.
   - L2 Autopilot — orders with no hard blocks, confidence ≥ threshold and decision APPROVE are approved
     and submitted automatically; everything else goes to humans.
   Promotion rule (shown on a dashboard): ≥ 300 decisions in the window with ≥ 98% agreement and zero
   critical misses. Automatic demotion to L0 on any critical miss or when agreement drops below the
   threshold. Daily random audit sample (e.g. 5% of autopilot orders) for a human to confirm.
5. **Guardrails**: AI never cancels, deletes, changes COD amount or recipient identity on its own; high
   value orders (configurable) always need a human; full prompt/response logging; global kill switch.

---

## 8. Vendor API change watcher

Daily job per vendor source:
- FHB v3 `https://api.fhb.sk/v3/openapi`, FHB Joy `https://api.fhb.sk/joy/openapi`,
  euShipments Postman collection JSON
  `https://documenter.gw.postman.com/api/collections/26992907/2s93Y2S2Q8?segregateAuth=true&versionTag=latest`,
  Shopify API release notes / version support.
- Normalise (sort keys, drop volatile fields), hash, compare with the last `ApiSpecVersion`.
- On change: structured diff (endpoints added/removed, fields added/removed/changed, enum values, changelog
  section text), Alert to admins, regenerate `docs/integrations/*.md` with `tools/render_docs.py`, and
  produce an **upgrade brief** (markdown) listing affected adapters, schemas and tests.
- Implementation is done in a Claude Code session from that brief; fixture tests updated; affected
  connections drop to DRY_RUN until a human confirms correct payloads, then return to LIVE.
  Nothing is auto-deployed from a vendor change.
- Daily read-only live check (schema-validate real production responses) catches undocumented changes:
  any new field, missing field or unknown enum value raises an alert.

---

## 9. Non-functional

- Performance: order list < 1s for 50k orders with filters; bulk fulfil 200 orders < 2 min.
- Reliability: at-least-once processing with idempotent handlers; no duplicate vendor orders (tested).
- Observability: request log per vendor call (status, latency), dashboards for queue depth, failure rate,
  token refreshes; alerts to email/Slack.
- Security: 2FA for all users, RBAC, audit log, encrypted credentials, HMAC on Shopify webhooks, secret
  path tokens on FHB callbacks, rate-limited login.
- GDPR: customer PII retention setting per account (e.g. 24 months), anonymisation job, export.
- i18n: UI in Bulgarian and English; validator messages in both.

---

## 10. Build phases (each ends with a demo + acceptance tests)

| # | Phase | Done when |
|---|---|---|
| 0 | Foundation: repo, CI, auth + 2FA, accounts, memberships, RBAC, credentials vault, audit log, worker + queues, deploy to Render | Two accounts, users switch between them, data isolation test passes |
| 1 | Shopify: Dev Dashboard app, connect stores, webhooks + reconcile, orders + products import, variant↔product matching queue | New Shopify order visible in CRM < 1 min; backfill works; HMAC verified |
| 2 | FHB v3 adapter (production, READ_ONLY → DRY_RUN): login, products, orders, status sync (callbacks + history sweep), stock, parcel services, PUDO; mirror screens | Read-only mirror complete and schema-clean; dry-run payloads reviewed; duplicate-submit test (mocked) green |
| 3 | euShipments adapter (production, READ_ONLY → DRY_RUN with `testMode`): companies, products, availability, orders, orders-history polling, delete, offices; mirror screens | Read-only mirror complete; `testMode` dry-runs accepted; phone normaliser test table green |
| 4 | Pipeline + CANARY → LIVE: validators, routing rules, review queue, single + bulk Fulfill, Shopify tracking write-back, alerts for BLOCKED | 50 canary orders end-to-end, then one store LIVE for a full day without manual fixes |
| 5 | Inbound + stock board + Shopify inventory push (dry-run first) | Receipt/booking created from XLSX; discrepancies raise tasks |
| 6 | Returns, RMA, COD boards | Return received notifications reach support; COD ageing report |
| 7 | Manual shipments + Joy labels + euShipments AWBs | Label PDF printed from CRM; tracking flows |
| 8 | AI: shadow mode → assist → autopilot per policy | Agreement dashboard; promotion/demotion rules enforced in tests |
| 9 | API change watcher + daily read-only live checks | Simulated spec change produces alert + diff + upgrade brief |

---

## 11. Open items to confirm before/while building

1. Which company (Account) owns which FHB and euShipments credential set, and which stores route to which
   warehouse by default (by country?).
2. Production credentials: FHB app_id/secret (ZOE), Joy appId/secret, euShipments API token. Confirm with
   euShipments that `testMode: true` on production creates nothing visible to the warehouse.
3. Are all Shopify stores in the same Shopify organisation (decides the token flow)?
4. Store codes for external ids (short, unique, permanent).
5. Should the CRM push stock to Shopify, or only display it, at launch?
6. Is FHB's "local returns" extra service active (otherwise `/return/*` returns nothing)?
7. euShipments: is Econt/Speedy cash-receipt configuration active on our senders (price-sum rule)?
