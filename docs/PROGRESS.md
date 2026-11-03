# Progress log

Claude Code updates this file at the end of every task: what was done, what is next, decisions taken,
open questions.

## Current phase
Phase 0 — Foundation (tasks done; waiting for GATE P0-G1)

## Decisions
- 2026-10-28: Production APIs only, no vendor sandboxes. Staged liveMode per connection (READ_ONLY → DRY_RUN → CANARY → LIVE).
- 2026-10-28: Stack and architecture per CLAUDE.md / SPEC.md. Vendor specs captured on this date.

- 2026-10-29: The GitHub repo is public. No real business data in git (see CLAUDE.md). Companies, stores,
  store codes, vendor accounts and routing are entered in the deployed CRM; only placeholders here.
- 2026-10-29: Hosting on the existing Render account, as new services (web, worker, Postgres) next to the
  existing ones.

- 2026-10-29: Versions pinned at build time: Next.js 16.4, React 19.3, Prisma 7.10 (driver adapter `@prisma/adapter-pg`,
  client generated to `src/generated/prisma`, config in `prisma.config.ts`), TypeScript 6.0 (typescript-eslint
  does not support TS 7 yet), Auth.js `next-auth@5` beta, pg-boss 12, Zod 4, Vitest 5, Playwright 1.63.
- 2026-10-29: Tenant isolation = `accountDb(accountId)` (injects/guards accountId in every query) + forced Postgres
  RLS on every table with `accountId` (`app.account_id` set per operation, `app.bypass_rls` only via `systemDb()`).
  The app must connect as a NON-superuser (superusers bypass RLS). Locally: role `crm_app`; on Render the default
  database user is not a superuser.
- 2026-10-29: pgvector is not a trusted extension: locally it is installed in `template1` (docker/db-init.sql) so
  the app role, the Prisma shadow DB and test DBs all have it. The first migration runs `CREATE EXTENSION IF NOT
  EXISTS vector` (Render allows it for the database user).
- 2026-10-29: Every relation between business tables is a composite FK (accountId, xId) → (accountId, id), so no row can
  point at another account's parent (FK checks ignore RLS). Optional relations use `onDelete: NoAction`; accounts are
  never hard-deleted. AuditLog is append-only (select/insert policies + trigger). Scoped clients disable `$transaction`
  and raw SQL; use `withAccountTransaction` (atomic, accountId injected) / `withSystemTransaction`.
- 2026-10-29: Auth = Auth.js credentials provider, JWT session (12 h) re-validated against the DB on every request
  (`sessionVersion`, `disabled`). 2FA (TOTP) is mandatory for every user, with replay protection; login rate limit
  5 failures / 15 min per email+IP, 20 per IP, 30 per email (only attempts that pass the per-IP limits count
  towards the email-wide one, so one source cannot lock a user out elsewhere); attempts are recorded before the
  check and purged hourly. The client IP
  is the right-most X-Forwarded-For entry (`TRUSTED_PROXY_HOPS`, default 1, for Render's proxy).
- 2026-10-29 (phase audit): people join through single-use invitation links (72 h; OWNER bootstrap 24 h). An admin
  never sees anyone's password or 2FA key: a new person chooses both on the link, an existing user must sign in
  and accept. The invitation page looks the same either way. The 2FA key for a new profile is generated on every
  page view and only travels sealed inside the form (30 min), so previewing a link reveals nothing reusable.
  Residual risk until links are emailed by the app: whoever holds a link (the inviter) could open it first and
  create the profile for that email — invite only people you would also give a password to.
- 2026-10-29: Outbox: `enqueueOutboundInTx` is idempotent per (connectionId, idempotencyKey); a DRY_RUN/REFUSED/FAILED
  row can be re-armed, a SENT/UNCERTAIN/in-flight one never. CANARY daily cap counts per UTC day. Global emergency
  pause: env `OUTBOX_PAUSED=1`; per-account kill switch = OWNER action (Складове и връзки → Аварийно спиране: all
  connections → READ_ONLY + pause, and every request still waiting is HELD with its CANARY confirmation cleared).
  Held requests never leave by themselves: an OWNER releases them explicitly and they are evaluated against the
  current mode (READ_ONLY refuses, CANARY asks again). Lock order is connection row → request row everywhere, so
  sender, kill switch and mode changes cannot deadlock; the CANARY cap counts in-flight and UNCERTAIN sends.
  The sweep fetches new work first with its own limit; parked rows are re-picked only when their condition can
  have changed (next UTC day for the cap, lifted pause).
- 2026-10-29: Re-arming a request and confirming a CANARY request are both conditional writes (status checked at
  write time, connection locked first), so a stale read can never resurrect an in-flight or held request. Leaving
  CANARY re-queues requests that were waiting for a click or for the next day's cap. Phase audit: docs/audits/phase-0.md.
- 2026-10-29: Review.embedding is `vector(1024)` (Voyage voyage-3.5 default size); revisit before P8-01 if another
  embedding model is chosen (changing it later needs a migration on a populated table).
- 2026-10-29: Sidebar per DESIGN.md plus four phase-0 admin entries under Настройки (Фирми и потребители, Ключове за
  достъп, Одит лог, Системни задачи). shadcn/ui components are added when the first complex widget needs one
  (dialogs/tables in phase 1); the phase-0 shell uses Tailwind with the DESIGN.md tokens.
- 2026-10-29: Render Blueprint in region `frankfurt`, plans starter/starter/basic-256mb; migrations run as
  `preDeployCommand` on web AND worker (a failed migration stops the deploy instead of crash-looping); the worker
  also refuses to start if a migration is missing, and the web app refuses to start on an RLS-bypassing DB role.

- 2026-11-02 (owner decision): the tenant is the business GROUP (Account); companies (Company) live inside it.
  Products and stock are group-wide so another company's warehouse can serve an order — recorded in the CRM only
  (no intercompany invoicing yet). Staff can be limited to companies (permission, not a DB wall); owners see all.
  Companies are archived, never deleted. companyId on Store/FulfillmentConnection/Order is nullable until the
  backfill migration has run everywhere; a later migration makes it NOT NULL.
- 2026-11-02: GATE P0-G1 in progress: Render web + worker + Postgres live (Frankfurt); owner enrolment pending.

- 2026-11-02 (P1-01, Shopify docs checked via the Shopify dev docs): client credentials grant confirmed —
  POST https://{shop}/admin/oauth/access_token (form: client_id, client_secret, grant_type=client_credentials),
  works only when the Dev Dashboard app and the store are in the same Shopify organisation (`shop_not_permitted`
  otherwise), token valid 24 h (expires_in 86399), refreshed by repeating the request. Webhooks are signed with
  HMAC-SHA256 of the raw body using the app's client secret (X-Shopify-Hmac-Sha256); deduplicate on
  X-Shopify-Webhook-Id. API version pinned to 2026-10 (latest stable, supported until 2027-10-16).
  WebhookSubscriptionInput uses `uri` in 2026-10. Stores outside the organisation would need the
  authorization-code flow — not built until a store needs it.

- 2026-11-02 (P1-02..06): Shopify 2026-10 schema checks — Customer has no email/phone (use
  `defaultEmailAddress.emailAddress` / `defaultPhoneNumber.phoneNumber`); ProductVariant has no `barcode`
  (use `barcodes(first:N){nodes{value}}`); `Order.risk` is `OrderRiskSummary!` {recommendation, assessments};
  webhook topics ORDERS_CREATE/UPDATED/CANCELLED/EDITED, REFUNDS_CREATE, PRODUCTS_UPDATE, APP_UNINSTALLED;
  `orders/edited` carries `order_edit.order_id`, `refunds/create` carries `order_id`.
  Decisions: webhook bodies are only pointers — the worker re-reads the order/product from Shopify; dedupe key
  is `<storeId>:<X-Shopify-Webhook-Id>`; when one shop is connected in two groups, the HMAC decides which store
  sent it. Webhooks are registered by the worker against `<public web URL>/api/webhooks/shopify`; the web service passes its public URL
  (RENDER_EXTERNAL_URL, or APP_URL) in the job payload — Render's `fromService host` is an internal name Shopify rejects.yaml). Order lines of not-yet-synced variants get a stub StoreVariantLink so the
  product sync / matching queue can attach them later. Manual variant links are never overwritten by auto-match.
  Before approval Shopify edits apply directly (lines, untouched address, cancellation); after approval only
  Shopify's status fields follow and meaningful changes open operator tasks. Test orders are imported ON_HOLD. Saved views in the orders list are URL-based for now (filters live in the query string).
  Phase 1 audit: docs/audits/phase-1.md (query-cost cap, stately queues, import lock, post-approval protection).

- 2026-11-02 (first live store): webhook URL fixed (see above); orders Shopify already reports FULFILLED when first
  imported get the new status FULFILLED_EXTERNALLY (outside the review queue, no tasks on later changes); "last sync"
  shows the time of the last run. Decision with the owner: master products are created from the warehouse catalogues
  (phases 2–3), not from Shopify variants — until then store variants stay unmatched.

- 2026-11-02 (wave 1, parallel agents): FHB v3 adapter (P2-01…P2-08), euShipments adapter (P3-01…P3-06) and the API
  change watcher (P9-01, P9-02) built in separate worktrees, each audited and fixed — docs/audits/wave-1.md; decisions and
  spec findings verbatim in docs/wave-1-notes.md (INTEGRATION_NOTES updated where the code deviates). Nothing calls a vendor
  yet: new connections start READ_ONLY; FHB has no test flag (DRY_RUN only records), euShipments DRY_RUN uses testMode:true.

- 2026-11-02 (wave 2, phase 4): order pipeline state machine (every Order.status change goes through
  src/server/pipeline with an OrderEvent), validator engine (OrderCheck, hard/soft findings, suggested fixes),
  routing rules + admin page, order review screen with editable address, decisions and review records, single/bulk
  Fulfill through the outbox (CANARY confirmation bound to the payload), Shopify fulfillment write-back (store mode
  gate in the sender), alerts/tasks list with email/Telegram providers (off until configured). Audit:
  docs/audits/wave-2.md; notes: docs/wave-2-notes.md.
  Behaviour change on deploy: the check sweep picks up existing IMPORTED orders and moves them to CHECKING, then
  READY or NEEDS_REVIEW (they are only checked, nothing is sent).
- 2026-11-02 decisions with the owner: operators can choose the warehouse by hand (P4-09); companies are grouped
  into product lines, one line per company (P5-00); master products come from the warehouse catalogues.
- 2026-11-02 (wave 3): product lines + master catalogue from a warehouse catalogue, line filter, Excel/CSV mapping,
  coverage (P5-00); manual warehouse choice "Изпрати от" and safe reroute "Пренасочи" (P4-09, database triggers forbid
  two active shipments per order); stock board, inbound creation, Shopify inventory push, off by default (P5-01..03);
  returns and COD boards (P6-01..02); FHB Joy labels, euShipments AWBs, manual shipments and bulk label PDF behind the
  outbox (P7-01..03); AI reviewer with embeddings, policies L0–L2, audit sample, kill switch and rule mining, off without
  ANTHROPIC_API_KEY (P8-01..04). Each track was audited and fixed: docs/audits/wave-3.md; decisions and open questions
  per track: docs/wave-3-notes.md. All migrations are additive (new tables, nullable columns or defaults).
  Open owner questions from wave 3: Shopify app scopes read_locations/read_inventory/write_inventory (for P5-03);
  support address for returns (RETURNS_SUPPORT_EMAIL_TO / RETURNS_SUPPORT_TELEGRAM_CHAT_ID); 14-day return/COD
  thresholds; is FHB's local returns service active (SPEC §11.6); whether L2 autopilot also submits (now: approve,
  then Fulfill by a person); AI high-value default amounts; retention of the AI prompt log; Joy parcel-service codes.
- 2026-11-03 (wave 4, phase 10): the five menu screens that were still placeholders — Товарителници, Тикети от склада,
  Офиси/PUDO/потребители, Справки, Фактури — built from data the system already mirrors (no new vendor writes). New tables:
  ShipmentBoardSettings, FhbTicket, FhbTicketEvent (+ report/directory indexes, pg_trgm for search). Audit:
  docs/audits/wave-4.md; notes: docs/wave-4-notes.md. Owner questions: euShipments cabinet URL for link-outs; FHB: does order
  delivery_point take the delivery-point id or external_code; euShipments per-AWB invoice fields could be read later.
- 2026-11-03 (owner request: full store editing + delete): Магазини → store page has "Данни на магазина" (name, company,
  currency, countries, domain, code; OWNER/ADMIN, audited before/after) and "Архив и изтриване" (OWNER only, new
  permission `stores.archive`). Rules (src/server/store-lifecycle.ts): the code is editable only while the store has no
  orders and no fulfillments (it is in every deterministic vendor id); the domain only while nothing was imported from or
  written to the shop (a domain change clears variant links/locations/inventory mirror and re-runs the connection test →
  webhook registration); a company move changes future orders only and, with matched variants, must stay in the same
  product line. Archive = new nullable Store.archivedAt/archivedById (migration 20261103120000_store_archive, additive):
  reconcile/backfill/sync/test/registration, Shopify inventory read + push (sweep, create, sender), and the API live
  check skip archived stores; webhooks for them are acknowledged (200) and not stored, already stored events become
  IGNORED; a `shopify.removeWebhooks` job deletes our subscriptions (webhookSubscriptionDelete, checked against Admin API
  2026-10) — failures shown with a retry button; a shop still used by another live store keeps them. Archived stores are
  hidden from pickers (routing — unless a rule already names them —, stock board) and listed under a collapsed
  "Архивирани"; orders stay visible/searchable (orders filter shows them as "архивиран"). Restore re-runs the
  connection test. Delete only without orders, fulfillments, write-backs, inventory pushes or routing rules, confirmed by
  typing the code; removes variant links, locations, inventory levels and the vault credential if nothing else uses it.
  A connected store with webhooks is archived first and deleted by the removal job after it succeeded (an OWNER may
  force the delete after a failed removal). Decision: Shopify fulfillment write-backs of an archived store's already
  shipped orders still run (they are not a sync job and keep Shopify's order status right).
  Audit fixes: a domain change resets writeBackMode/inventoryPushMode to READ_ONLY/DISABLED (audited; only an OWNER
  raises them again), marks the store's queued Shopify events IGNORED, and queues a removal of our webhooks on the old
  shop (same credential, `oldDomain` job); events now carry `shopDomain` and the worker ignores one whose shop no
  longer matches the store. The removal job decides the purge from the store (`deleteRequested` + archived), not the
  job payload (jobs are coalesced per store). The intake tries live stores before archived ones; a shop counts as
  shared only with another live store on the same app (same client id). Order imports take `store:<id>` as a shared
  advisory lock, store edits/deletes exclusively, so the "no orders yet" re-check is serialised with a first import.

- 2026-11-03 (fix at the source, owner request): per-country phone rules and master product weights.
  Настройки → Държави lists every country: the euShipments guideline rules (BG RO GR PL CZ HU SK HR) read-only, our
  own rules (CountrySetting.phoneRules, Zod-checked) for the others; normalisePhone / normalisePhoneE164 take the
  group's rule through every caller (euShipments orders and AWBs, FHB orders, Joy labels, order checks, review
  edits); built-in always wins. On the order screen a phone finding of an undocumented country offers
  "Добави правило за <CC>" (pre-filled from the order's phone, live preview, warning to confirm with the warehouse);
  saving re-checks every open (pre-approval) order of the group to that country (25 inline, the rest via
  orders.check). euShipments weight_missing now names the product (`product:<id>.weightGrams`) and the order screen
  offers "Въведи тегло"; the master weight is also editable on Продукти → product page (OWNER/ADMIN/OPERATOR,
  `products.weight`), audited with source/author, and re-checks open orders with that product. Suggestions: euShipments
  get-products WEIGHT (kg), FHB product weight (unit undocumented — shown, one click only), Shopify variant weight
  (`inventoryItem.measurement.weight`, now read by the variant sync). "Попълни теглата от склада" fills only masters
  without a weight from euShipments (conditional update, never overwrites). Optional "Обнови теглото и в Shopify":
  ShopifyWeightWrite, one row per (variant, weight), gated in the sender by the new per-store "Тегло към Shopify"
  mode (DISABLED default → DRY_RUN records the exact productVariantsBulkUpdate payload → LIVE reads back, sends,
  reads back on an unclear answer; raising is OWNER-only). Migration additive (nullable columns, a defaulted column,
  one new table with RLS). Shopify 2026-10 fields checked with the Shopify docs/schema tools. Owner to do: add the
  `write_products` scope to the Shopify app (release + reinstall) before raising the weight mode to LIVE; confirm
  the CY phone format (+357 + 8 digits) with euShipments; then DRY_RUN → check the recorded payload → LIVE.
  Audit fixes (same day): the weight sender refuses a row whose weight is no longer the master weight
  ("superseded") in the claim, right before the mutation and in the stale-SENDING sweep, so an older retry or a
  crashed send can never put a stale weight back over a newer one; tests now cover 5xx/network + read-back,
  backoff → FAILED + task, crash recovery and definite rejections. Weight actions respect company/line scope
  (restricted members: their lines' masters + masters without a line). A custom phone rule must use the
  country's ITU calling code (`calling_code_mismatch`; the form shows it read-only). Lower-case address country
  codes are re-checked too. Decision for the owner to confirm before merge (CLAUDE.md "ask before changing the
  data model of an existing table with data"): the additive columns on Product (weightSource/SetAt/SetById),
  Store (weightWriteMode, default DISABLED) and StoreVariantLink (shopifyWeightGrams) — no existing value changes.
  Before LIVE: run `pnpm check:live` with VARIANT_WEIGHT_READ_QUERY against one store (the mutation args/inputs were
  re-checked in the Admin schema: productVariantsBulkUpdate(productId, variants), InventoryItemMeasurementInput.weight).

- 2026-11-03 Shopify lifecycle write-back (owner request: "the order must be fulfilled in Shopify, and when
  tracking appears it goes back to Shopify and the statuses change"). Per shipment, through the same sender
  (writeBackMode gate at send time, claim, read-back before every send/retry, UNCERTAIN + task, kill switch):
  FULFIL (one per shipment; per-store "Маркирай изпълнена в Shopify" = ON_TRACKING default — unchanged — or
  ON_ACCEPT: fulfillmentCreate once the warehouse accepted it, without tracking and with notifyCustomer=false when
  there is no number yet; choosing ON_ACCEPT is OWNER-only) → TRACKING (fulfillmentTrackingInfoUpdate, one per
  tracking value, notifyCustomer from the store setting; carrier mapped to Shopify's documented spelling, else
  sent as we have it) → EVENT (fulfillmentEventCreate, one per FulfillmentEventStatus: SHIPPED → IN_TRANSIT,
  DELIVERED/COD_PAID → DELIVERED, RETURNING/RETURN_RECEIVED/EXCEPTION → FAILURE; never an earlier status after a
  final one, in our rows or in Shopify → REFUSED "superseded_by_…"). TRACKING/EVENT rows wait in LIVE until the
  FULFIL row is SENT (REFUSED "fulfillment_not_in_shopify" if it never will be). A fulfilment without tracking is
  recognised in the read-back as a Shopify fulfillment that did not exist at our first attempt and holds exactly
  our lines (stored with the request as readBack). Cancelled / re-routed shipments never write (sweep + claim).
  Migration additive: ShopifyWriteBack.kind/value (defaults), trackingNumber nullable, unique widened to
  (shipment, kind, value) — new index created before the old one is dropped; Store.fulfilTrigger default
  ON_TRACKING. Scopes (2026-10 docs): fulfillmentCreate / fulfillmentTrackingInfoUpdate need
  write_merchant_managed_fulfillment_orders (or write_third_party_/write_assigned_fulfillment_orders for
  locations run by a fulfillment-service app); fulfillmentEventCreate needs write_fulfillments; the read-back
  `fulfillment(id)` needs read_orders. Owner to do: make sure the Shopify app has write_fulfillments (release +
  reinstall if it was added), then choose the trigger per store and check the DRY_RUN rows on an order page.
  Audit fixes: (1) any final event already in Shopify (DELIVERED / FAILURE) supersedes the other one; (2) EXCEPTION
  → DELAYED (rank 1.5, not final), so DELIVERED still follows a temporary courier exception; FAILURE only for
  returns; (3) an UNCERTAIN FULFIL keeps its TRACKING / EVENT rows waiting, and rows REFUSED
  "fulfillment_not_in_shopify" are re-armed by the sweep once their FULFIL row is SENT with a gid; (4) a shipment
  cancelled / re-routed after its FULFIL was SENT opens one task "shopify_writeback_orphaned" (marker in lastError);
  the replacement shipment of the same order with the same lines adopts that Shopify fulfillment (read back: not
  cancelled/failed, same lines, not taken by another live shipment) — SENT without fulfillmentCreate,
  trackingNumber cleared so its tracking follows as a TRACKING row; no fulfillmentCancel path; (5) DRY_RUN rows
  re-armed for LIVE drop their request (fresh read-back key); fulfillment read-back pages fulfillmentLineItems /
  events (reverse: true) with pageInfo.hasNextPage — an incomplete page throws (retry before send, UNCERTAIN
  after an unknown outcome). Open for the owner before merge: existing LIVE stores start sending tracking updates
  and status events (DELIVERED may trigger Shopify's customer notification) for shipments of the last 14 days
  with a FULFIL row, and the additive Store / ShopifyWriteBack columns need the owner's OK (CLAUDE.md).

- 2026-11-03 "Откажи в склада" from the CRM (owner request: "if we do not want to use the warehouse panels — how do we
  delete from our CRM? e.g. we make a mistake"). Order page → Пратки: per active shipment a button "Откажи в склада"
  (new permission orders.cancelShipment = OWNER/ADMIN; orders.cancelAtWarehouse stays OWNER/ADMIN/OPERATOR for edits
  and label voids), offered only while the vendor still allows it (FHB raw `pending`; euShipments New / Information
  received / Awaiting pickup and ≤ 14 days — the same rule reroute uses), otherwise "вече не може да се откаже оттук —
  само в кабинета на склада". Label shipments (FHB Joy / AWB) are not offered here: their documented void stays on the
  manual shipment page (link shown). Confirmation dialog with a required reason ("warehouse" codes; new default
  "Изпратена по грешка") + note + acknowledgement; timeline entry + audit. Queued through the outbox with the SAME keys
  as reroute (`fhb.order.delete:<id>`, `delete:<ref>`), marked `warehouseCancel` in the CRM-only payload context; the
  order row lock + the outbox key make a double click / concurrent request one request ("already_requested"); refused
  while a reroute is open. The sender's liveMode gate decides (READ_ONLY refused, DRY_RUN recorded and shown on the
  card, CANARY confirm button, LIVE sent). Vendor confirms (FHB DELETE / read-back gone; euShipments delete effect,
  orders-history "Deleted" or twice "not found" for a CRM delete): shipment CANCELLED, ORDER → BLOCKED (cause vendor,
  src/server/override/cancel-effects.ts) with an info entry "отказана в склада от <user>: <reason>" — so "Изпрати
  отново" (new id) or "Откажи поръчката". Before, a CRM-requested euShipments delete moved the order to CANCELLED and
  an FHB delete did not move it at all. A later "Deleted" never moves BLOCKED on to CANCELLED. Vendor refuses (FHB
  4xx, euShipments delete error — new adapter effect orderDeleteRejected): shipment unchanged, task
  "warehouse_cancel_refused" on the order. Reroute-owned shipments are never touched (reroute flow unchanged).
  "Откажи поръчката": the pipeline's cancel rule now also allows BLOCKED / EXCEPTION / UNKNOWN (user only), guarded:
  no active shipment and (from those states) no vendor write of the order PENDING/PAUSED/AWAITING/HELD/SENDING/
  UNCERTAIN; it is the review 'block' decision (reason required, Review record, BLOCKED_TASK_KIND Shopify task), shown
  as "Откажи поръчката" in the decision bar. No migration. Tests: src/server/override/warehouse-cancel.test.ts, e2e
  tests/e2e/cancel-at-warehouse.spec.ts (DRY_RUN request, confirmed cancel simulated by the real euShipments effect).
  Audit fixes (same day): a delete counts as "CRM-requested" (BLOCKED with attribution, no cabinet task) only when its
  outbox row actually left the CRM (SENDING / SENT / UNCERTAIN) — a DRY_RUN / READ_ONLY / FAILED row followed by a
  cabinet deletion still raises the CRITICAL eushipments_cancelled_at_vendor task (cancel-effects CANCEL_LEFT_CRM).
  A reroute is now refused ("cancel_requested") while a warehouse cancel of the shipment is in flight, and never
  attaches to an existing cancel row. euShipments dialog says plainly that the order can NOT go to euShipments again
  (same `{PREFIX}-{number}` reference) — only another warehouse or cancel; FHB keeps "new id". An euShipments 401 on the
  delete is not reported as a warehouse refusal (no task; card "not sent: credentials"). Explicit accountId on the
  membership/alert lookups. New tests: CANARY confirm path, euShipments 503 → orders-history read-back, FHB network
  error → GET /order 404 read-back, markGoneAtVendor requested/not-requested paths, reroute-after-cancel refusal.

- 2026-11-03 "Активирай продуктите в тази локация" (owner request after the live test: a store with two Shopify
  locations mapped to two warehouses; the push preview only showed the first, because the products are not stocked at
  the second and the plan skips them as not_stocked_at_location). On Магазин → Наличности към Shopify every mapped,
  active location has the button with N = linked variants (productId set, tracked) whose inventory item has no level
  there but is known from another location's level (src/server/stock/activate.ts, one entry per item). OWNER only (new
  permission inventory.activate), a second click confirms the count (the job is not queued when the count changed),
  audited (inventory.activation_queued / _dry_run / _sent / _failed). Writes: inventoryActivate(inventoryItemId,
  locationId) @idempotent(key) — 2026-10 schema/reference checked; no available/onHand (level starts at 0, the next
  push sets the warehouse number). Not inventoryBulkToggleActivation: it toggles one item across many locations (no
  batching for many items at one location), can deactivate, and does not document @idempotent. Own outbox
  (InventoryActivation + lines, new tables only, RLS): the store's inventoryPushMode at send time (DISABLED → REFUSED,
  DRY_RUN → the exact requests stored at creation are shown on the page, LIVE → sent), kill switch / OUTBOX_PAUSED →
  PAUSED, an unmapped location → REFUSED, one open job per store + location (advisory lock), row-lock claim, the write
  client never retries; per item a deterministic key per (store, item, location) (activationIdempotencyKey); batches
  of 50 are read back first (nodes → inventoryLevel(locationId)) so an already-stocked item is "already" (success); a
  userError with a level afterwards is "already", without one "failed" (message shown); an unknown outcome is read
  back (level → activated, else retried later with the same key). After a LIVE success the worker queues the store's
  Shopify inventory read. The preview's "Пропуснати" shows not_stocked_at_location per location with a hint to the
  button. Location names: "#2" / "#3" are the merchant's real Shopify names; owner decision — the CRM shows
  every location exactly as Shopify names it and never replaces it (the mapped warehouse is shown next to it).
  Tests: src/server/stock/activate.test.ts, src/integrations/shopify/inventory.test.ts, e2e tests/e2e/stock.spec.ts.
  Auditor fixes (same day): the job stores the mode the owner confirmed under (InventoryActivation.createdMode,
  additive nullable column, migration 20261103200000) and sends only when that AND the current mode are LIVE — a job
  confirmed as a dry run and raised to LIVE while it waited is REFUSED `mode_raised_after_confirm` (new click needed);
  THROTTLED / HTTP 429 on inventoryActivate (not executed) stops the run and re-arms it in 30 s with the same keys
  without spending an attempt (was: an unknown outcome that used up attempts); lockedAt is refreshed per item and
  finalize/heartbeat require the claim's attempts number, so a long run is not processed twice after a stale re-arm;
  the per-location hint now counts exactly the button's items (tracked, one per inventory item). The 2026-10
  reference excerpt (args, payload, required @idempotent, deprecated stockAtLegacyLocation) is in INTEGRATION_NOTES §6.

## Open questions
See SPEC.md §11.
- For GATE P3-G1 (ask euShipments): (1) which endpoint returns a product's stored barcode (get-products has none) —
  until then the sent barcode is kept in VendorProduct.raw.barcodeSent; (2) what create-order returns with
  `testMode: true` (we treat 2xx without error text as a pass); (3) time zone of orders-history DATE values (read as
  Europe/Sofia); (4) is get-prod-avails CUST_NAME exactly the get-user-companies NAME (used to attribute stock rows
  when one token sees several companies).
- Owner: put vendor cabinet screenshots in docs/reference-screens/{fhb,eushipments}/ (local only, git-ignored) so the
  mirror screens can be checked field by field (P2-08 / P3-06 coverage check not done).

## Done
- P0-01 scaffold (pnpm, Next.js App Router, worker entry, ESLint+Prettier, Vitest, Playwright, pino, scripts).
- P0-02 docker-compose (Postgres 16 + pgvector), `.env.example`, throwaway test DB per `pnpm test` run (tests/test-db.ts).
- P0-03 full Prisma schema for SPEC §3 incl. enums (LiveMode, CrmOrderStatus, OutboundStatus…), ERD comment.
- P0-04 tenant-scoped DB client + RLS migration; isolation tests (src/server/db/tenant-isolation.test.ts); audit
  findings fixed (composite FKs, global models, real transactions, append-only audit log).
- P0-05 Auth.js email+password+TOTP, sessions, rate-limited login; e2e login with 2FA (tests/e2e/auth.spec.ts).
- P0-06 accounts, memberships, roles, account switcher, RBAC matrix (src/server/auth/rbac.ts) with tests.
- P0-07 credentials vault (AES-256-GCM, AAD-bound), write-only UI, log redaction; tests prove no secret leaks.
- P0-08 audit log service + UI list (Настройки → Одит лог).
- P0-09 pg-boss worker: queues, cron, retry/backoff, dead letters + view with redrive (Настройки → Системни задачи).
- P0-10 outbox + sender with the liveMode gate, CANARY confirmation + daily cap, kill switch, read-back on unknown
  outcome, UNCERTAIN tasks; duplicate-submit and concurrency tests.
- P0-11 i18n (bg default, en), shell per DESIGN.md, empty pages; Playwright smoke + screenshots in docs/screens/.
- P0-12 render.yaml (web, worker, Postgres) validated against Render's schema (`pnpm render:validate`), health
  endpoints `/api/health` and `/api/health/ready`; GitHub Actions CI (typecheck, lint, tests).

- P1-01 Shopify GraphQL client (client credentials token, cost-based throttling, retries, Zod).
- P1-02 Магазини: add store (company, domain, code, currency, countries, app credentials → vault), settings
  (COD gateways, SKU prefix, write-back / stock push modes — raising them is OWNER-only), credential rotation,
  connection test job, manual sync buttons.
- P1-03 `/api/webhooks/shopify` (raw-body HMAC, size cap, dedupe, fast 200) + processing and registration jobs.
- P1-04 order import (idempotent, out-of-order safe, COD detection, normalised + original address, risk, tags),
  15-minute reconcile cron (also re-queues stuck webhook events), backfill N days (audited).
- P1-05 variant import + SKU auto-match with prefix stripping; matching queue (Продукти): link to a master SKU or
  create the master product from the variant.
- P1-06 orders list (tabs with counts, search, store/country/payment filters, paging), read-only order detail,
  Начало with attention numbers, today vs yesterday KPIs, COD by currency, recent orders. E2E with synthetic
  fixtures (tests/e2e/shopify.spec.ts, seed in tools/e2e.ts).

## Next
- GATE P1-G1 (owner): Shopify Dev Dashboard → create one app in the organisation that owns the stores, the scopes
  in SPEC §4 plus protected customer data access (otherwise addresses come back empty), release a version and install it on every store; then in
  the CRM Магазини → Добави магазин enter domain, code, currency, countries and the app's client ID + secret.
  The connection test, webhook registration, product sync and first order sync start automatically. Then set the
  SKU prefix and the COD gateway names per store and clear the matching queue in Продукти.
- Then phase 2 (FHB).
