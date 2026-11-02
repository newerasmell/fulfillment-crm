# Wave 3 — as-built notes


## P5-00 Product lines + catalogue

Commits: bc7cd59 P5-00: product lines + master catalogue (lines, sidebar line filter, catalogue job, suggestions, Excel/CSV mapping, coverage, line-bound routing fallback)

- P5-00 Product lines + master catalogue: ProductLine model, Company.lineId and Product.lineId (nullable, additive), Настройки → Линии и фирми at /settings/lines (OWNER/ADMIN, audited: line.create/update/archive, company.line)
- Master catalogue tool at /products/lines: 'Създай основни продукти от каталога на склад' runs as the background job lines.catalogue (stately per line, batches of 50 in small transactions, resumable cursor, progress and conflicts on MasterCatalogueRun, page refreshes itself while a run is open). SKU = vendor id with the connection prefix stripped, case-insensitive dedupe, unassigned masters adopted into the line, SKU used by another line reported as a conflict. Links that warehouse's products, then auto-links the rest of the line (other warehouses and store variants of the line's companies) by SKU after prefix. Idempotent.
- Match suggestions inside the line only: SKU = 1.0 (the key); barcode/EAN and name similarity (Dice bigrams) are hints only, with a capped score. Потвърди / Друго (another SKU in the line, or 'Не е това', stored in ProductMatchDismissal). Audited.
- Excel (.xlsx, written and read without a new dependency in src/lib/xlsx.ts) and CSV export of the mapping per line via GET /api/lines/[id]/mapping. Columns: master SKU, name, one column per warehouse connection and per store with [id] in the header; unlinked items exported as rows with an empty SKU. Import validates the whole file first, stores a preview (ProductMappingImport) shown at /products/lines/import/[id], then applies in batches with a stale check. Audited as line.mapping_imported.
- Coverage report per line (target ≥ 99%) on Продукти, /products/lines and Настройки → Линии и фирми
- Sidebar line filter (cookie crm_line) above the company filter, plus a line colour band at the top of the work area. companyFilter() and the alerts visibility now narrow to the line's companies, which covers orders, stock, tasks/alerts, dashboard and stores. Products are filtered by Product.lineId. 'Всички линии' is offered to OWNER/ADMIN only; restricted members see only lines of their companies.
- Orders list shows a line chip, a company chip, the shipping warehouse and the '↔ склад на друга фирма' marker
- Routing stock fallback only considers warehouses whose company is in the order's product line (engine + route loader). The FHB, euShipments and Shopify sync auto-matching, the manual variant link and createProductFromVariant all stay inside the line. The existing per-variant matching queue keeps working.
- Tests: src/server/lines/lines.test.ts (19 tests: pure scoring, line pick and visibility, routing line fallback, xlsx/csv round-trip, catalogue run incl. dedupe/conflict/idempotency/resume, sync matching in line, suggestions, coverage, export/import incl. validation and stale preview, restricted scope, cross-group isolation). e2e tests/e2e/lines.spec.ts passes on the production build (port 3101).

**Schema:** Migration prisma/migrations/20261102182557_product_lines (BEGIN/COMMIT, additive only, applied to the shared dev DB):
- New tables: ProductLine, MasterCatalogueRun, ProductMatchDismissal, ProductMappingImport. Each has forced RLS with the account_isolation policy and composite (accountId, id) foreign keys.
- New nullable columns: Company.lineId and Product.lineId, with composite FKs to ProductLine (NO ACTION) and an index on Product(accountId, lineId). No NOT NULL column and no backfill.
- Back-relations added: Account.productLines, FulfillmentConnection.masterCatalogueRuns.
- New models sit in one block at the end of schema.prisma under the 'wave 3 core' banner.
- tests/unit/migrations.test.ts SEED now also inserts a Company row, because this migration alters Company. The test passes.
- The ProductLine.color column default is 'indigo', which is not a palette token. The app always sets the colour explicitly and maps unknown values to 'rose'.

**Notes:**

BACKLOG: mark P5-00 [x].

DECISIONS
1. Model
   - A company is in at most one line by construction (Company.lineId).
   - Masters (Product.lineId) and companies without a line are 'unassigned'.
   - Product keeps its group-wide unique (accountId, sku): two lines can never share an exact SKU. The catalogue run reports such a SKU as a conflict with samples instead of creating it.
   - Case-insensitive dedupe inside a line is enforced in code. Master writes of one line are serialised with lockKey('product-line:<id>').
2. Automatic matching stays in the line
   - Applies to the FHB product sync, euShipments get-products, the Shopify variant sync, the manual 'link to SKU' in the matching queue, and createProductFromVariant (which sets the master's line).
   - Allowed targets are the line's masters plus unassigned masters (lineId null), for back-compatibility until every master has a line. Another line's masters are never matched.
   - Companies without a line keep the old group-wide behaviour.
   - The catalogue tool's own auto-link and the suggestions use the line's masters only.
3. Routing
   - The stock fallback considers only connections whose company's line equals the order company's line. Null equals null, so nothing changes until lines are set.
   - Explicit routing rules are not restricted: they are an admin decision.
4. Line filter
   - Cookie crm_line; AccountContext has new fields lines, activeLineId and lineCompanyIds.
   - With a line picked, ctx.companies (company menu and forms) and companyFilter() narrow to that line's companies, so every company-owned list follows.
   - Picking a line resets the company filter.
   - OWNER/ADMIN may choose 'Всички линии'; everyone else is defaulted to their first visible line.
   - A restricted member whose companies have no line sees no line filter. Companies without a line are hidden from such members while a line is selected, and Настройки → Линии и фирми warns about companies without a line.
5. Catalogue runs
   - stately queue lines.catalogue with singletonKey = lineId. The worker drains other QUEUED runs of the line after each run, because stately keeps only one waiting job per line.
   - A failed run is retried by pg-boss from its cursor; a DONE run is never re-run.
6. Import
   - Additive only: links are added or moved, and an empty cell removes nothing.
   - A new SKU with a name creates a master. An unassigned master is adopted into the line.
   - Any error marks the import INVALID and writes nothing.
   - Apply refuses if any link changed since the preview. If something changes during apply, the batches already committed stay and the import is marked FAILED, never applied twice.
   - Files are capped at 900 KB because of the Next.js 1 MB server-action body limit. A line of 800+ products is about 150 KB.
7. Excel without a new dependency: src/lib/xlsx.ts holds a minimal ZIP + SpreadsheetML writer and reader, with zip-bomb limits, plus a CSV that uses ';' and a BOM.
8. New permissions: lines.manage (OWNER, ADMIN) and lines.catalogue (OWNER, ADMIN, OPERATOR, WAREHOUSE). Confirming or dismissing suggestions uses the existing products.match permission.

SHARED-FILE CHANGES OTHER TRACKS SHOULD KNOW
- src/server/db/client.ts: TypeScript hit TS2590 ('union type too complex') in withRls once the schema grew. args and query are now passed through plain types. Runtime behaviour is unchanged. Other wave-3 tracks that add models will hit the same error without this change.
- companyFilter() now takes an optional lineCompanyIds.
- RoutingConnection and RoutingOrder have an optional lineId.
- The orders list returns company, line and warehouse { name, type, companyName, otherCompany }.
- playwright.config.ts was reformatted by prettier because lint failed on it at the base commit.

E2E
- Own group from tests/e2e/seed-lines.ts, with env E2E_LINES_EMAIL, E2E_LINES_PASSWORD and E2E_LINES_TOTP.
- No worker runs during e2e, so tools/e2e-lines-worker.ts processes the queued catalogue run in its place.

BEHAVIOUR ON DEPLOY
- Nothing changes until an owner creates lines and assigns companies.
- Then sync matching, suggestions and the stock fallback become line-bound, and non-admin members are filtered to a line.

OPEN / FOLLOW-UP
- P4-09 ('Изпрати от' with stock per warehouse of the same line) can use lineMembers() and the line on RoutingConnection.
- The order detail page shows no line chip yet; only the list does.
- Справки is still a placeholder, so it has no line filter.
- Run the auditor on wave3/core.

Commits: e709118 P5-00 audit fixes: company scope inside multi-company lines, xlsx/CSV upload hardening, race-safe catalogue and import

- HIGH company scope in multi-company lines: lineMembers(accountId, lineId, scope) now drops the connections and stores of companies outside the member's scope. exportMapping, planImport (it gets the actor's scope from previewImport), listSuggestions, lineCoverage and listCatalogueRuns all use it, and so do the /products/lines, /products and /settings/lines pages. Before writing, applyImport checks every plan item against the scoped connections and stores; an out-of-scope item gives import_stale and nothing is written. New DB test: line with companies A and B, actor scoped to A. The export has no B column or code, an import naming a B column gives unknown_column, suggestions show only A items, coverage covers only A's warehouse and store, and an owner's plan that touches B is refused for the A-scoped actor with nothing written
- MEDIUM xlsx memory: rows are capped at MAX_SHEET_ROWS=5002 (by r attribute and by row count), columns at MAX_SHEET_COLUMNS=500, and total padded cells at 1M; each limit raises SpreadsheetError. Tests cover r="99999999", XFD1, and 6000 rows without r
- MEDIUM catalogue overwrite: mastersBatch now links with updateMany({id, productId:null}) and counts it as alreadyLinked when count is 0. mastersBatch is exported. Test: a stale row whose item a person had linked by hand to K1 keeps that link
- MEDIUM routing: company-less (shared group) warehouses stay eligible for the stock fallback on every line, using c.companyId === null || lineId === orderLine. A warehouse of a company that is not in any line yet is deliberately NOT eligible for an order that has a line (reason is in the code comment and in notesForProgress). Engine test added
- MEDIUM partial rollout: new pure helper companiesForLine(). While a line is active, restricted members (who cannot pick 'all lines') keep their companies that have no line, so ctx.companies and lineCompanyIds still include them; the /products page also shows those members masters without a line (lineProductWhere). Pure test added
- LOW double start: startMasterCatalogue now does find-or-create inside withAccountTransaction under lockKey catalogue-start:line:connection. Test: two concurrent starts give one run and one audit entry
- LOW regex injection: the r:id lookup now uses fixed patterns and compares the Id in code; unesc drops code points above 0x10FFFF; readXlsx turns any parse error into SpreadsheetError('bad_file'). Tests added
- LOW CSV formula injection: writeCsv puts an apostrophe in front of cells that start with = + - @ tab or CR, and quotes them; readCsv strips that apostrophe again, so the round trip works. Test added
- LOW tests: the assertion that always passed is replaced with exact items and total for the restricted textiles actor. Concurrent applyImport test added; applyImport now claims PREVIEW→APPLYING before the stale check and puts the import back to PREVIEW when it is stale, so the second click deterministically gets import_not_ready
- LOW colour default: ProductLine.color defaults to 'rose' in the schema, with a follow-up additive migration 20261102190338_product_line_color_default (ALTER COLUMN SET DEFAULT)

**Schema:** ProductLine.color @default changed from "indigo" to "rose". New migration prisma/migrations/20261102190338_product_line_color_default/migration.sql: BEGIN; ALTER TABLE "ProductLine" ALTER COLUMN "color" SET DEFAULT 'rose'; COMMIT. Additive only; existing rows keep their value. It has been applied to the shared dev DB.

**Notes:**

P5-00 audit fixes (branch wave3/core, commit e709118). Decisions to record:
1) Routing stock fallback with lines: a shared warehouse (FulfillmentConnection.companyId null) stays eligible for every line, because the stock check (every master of the order in stock there) proves it carries the goods. A warehouse of a company that is not in a line yet is NOT eligible for an order that has a line: until the company is assigned, its vendor products are matched group-wide, so its stock proves nothing. During a partial rollout, the owner should put all companies that sell the same goods into the line together. An order without a line still uses only warehouses with no line (unchanged).
2) Restricted members (not OWNER/ADMIN) with a line active also keep their companies that have no line, and masters with no line on /products, so no work disappears during a partial rollout. OWNER/ADMIN keep the strict line filter, since they can pick 'all lines'.
3) applyImport now claims the import (PREVIEW→APPLYING) before the stale check and returns it to PREVIEW when stale. A plan whose items fall outside the applier's company scope is refused as import_stale.
4) Every xlsx limit (too_many_rows / too_many_columns / too_many_cells / bad_file) shows the user the generic 'bad_file' message. A specific 'too many rows' message would be a small i18n follow-up.
Open, not changed: the catalogue run's autolink phase (autoLinkLine) links SKU matches across every company of the line, even when a company-restricted member started the run. This follows the owner decision that companies in one line sell identical goods; the auditor did not flag it, but the owner may want to confirm it. The pg 'client.query() while already executing' deprecation warning also shows up in the e2e web server; it was not investigated and may predate this branch.


## P4-09 Manual warehouse choice + reroute

Commits: 6c460db P4-09: manual warehouse choice ("Изпрати от") and safe reroute after sending ("Пренасочи")

- P4-09 (1) Изпрати от: the warehouses of the order's product line (plus shared ones), each with stock for the order lines and a '↔ склад на друга фирма' marker. A reason is required (configurable 'warehouse' reason codes: няма наличност / по-бърза доставка / клиентът поиска / друго + text). The choice is stored as OrderWarehouseChoice, and validateOrder re-runs for it and keeps it on every later re-check. The check records OrderCheck.connectionId plus routing.via 'manual' with manual{who, reason, routed}. Each choice writes an OrderEvent, a REROUTE Review and an audit entry. An APPROVED order is reopened, and its check is made stale in the same transaction, so approval and Fulfill only work for the chosen warehouse. The check_connection_mismatch guard is still in place and tested. Clearing the choice returns to the routing decision. Needs OPERATOR+ (orders.review).
- P4-09 (2) Пренасочи към друг склад: OWNER/ADMIN only (new permission orders.reroute). Allowed only while the old shipment can be cancelled (FHB raw status pending; euShipments New / Information received / Awaiting pickup within 14 days, via the newly exported isEuOrderDeletable). The new warehouse is pre-validated: hard findings refuse the request before anything is queued. The cancel goes through the outbox with the existing keys (fhb.order.delete / eushipments delete), so the mode gate in the sender applies. A worker sweep (orders.rerouteSweep, every minute) waits while the request is pending, paused, held or awaiting CANARY confirmation. Only after SENT plus a read-back confirming the cancel does one transaction (order row locked) do the switch: old Fulfillment → CANCELLED, choice via 'reroute', order → APPROVED through the new pipeline cause 'reroute', which is guarded against any active shipment. A FAILED or not-sent cancel, an UNCERTAIN outcome, or 10 unconfirmed read-backs open a task and change nothing else. DRY_RUN or READ_ONLY ends as SIMULATED with what would have happened. The order page has a CANARY confirm button for the cancel request.
- Never two active shipments: database triggers refuse a second active Fulfillment per order (inserted, or re-activated from SUBMIT_FAILED/CANCELLED) and a second open reroute per order; both lock the Order row first. A superseded shipment (one with a DONE reroute) is never reactivated by late FHB or euShipments statuses and never moves the order (followShipment gains an optional fulfillmentId; fhb/apply.ts and eushipments/statuses.ts pass it). fulfillOrder turns the trigger error into SKIPPED already_submitted.
- Order page: new 'Изпрати от' card and 'Пратки' card (shipments, reroute form, open-reroute status with the cancel request state, reroute history); timeline labels for the new events. Прегледи → Причини admin can mark a code for 'warehouse'. i18n namespace 'override' in bg (default) and en.
- Tests: src/server/override/override.test.ts (16 tests): eligible list and line filter, the reason rules, the choice binding approval and Fulfill, reopen of an APPROVED order plus the mismatch guard, clearing, a chosen warehouse later disabled, OPERATOR forbidden from rerouting, the cancellable windows, confirmed reroute followed by three parallel Fulfills giving one shipment, a late status of the superseded shipment ignored, races (two requests → one; two confirmations → one switch), trigger refusals, refused / uncertain / unconfirmed / DRY_RUN outcomes, and a hard-findings refusal. e2e tests/e2e/override.spec.ts (2 tests) passes on a production build (E2E_PORT=3102), with its own seed group (tests/e2e/seed-override.ts) and tools/e2e-override-worker.ts playing the worker with a mocked vendor.

**Schema:** Migration prisma/migrations/20261102191734_order_override (BEGIN/COMMIT, additive only). New tables OrderWarehouseChoice (unique per order; FKs to Order and FulfillmentConnection, cascade) and OrderReroute (status CANCEL_QUEUED|DONE|REFUSED|UNCERTAIN|SIMULATED, cancelRequestId, outcome JSON, readBackAttempts; FKs to Order, Fulfillment fromFulfillment (NoAction) and FulfillmentConnection 'RerouteTarget'), both with forced RLS. Schema back-relations added: FulfillmentConnection.warehouseChoices/rerouteTargets, Order.warehouseChoice/reroutes, Fulfillment.reroutesFrom; the new models sit in one block at the end of schema.prisma. Triggers: fulfillment_one_active on Fulfillment (BEFORE INSERT OR UPDATE OF status, orderId) and order_reroute_one_open on OrderReroute. No existing column is altered and nothing is backfilled. The triggers only check rows written from now on, so existing data can never make the migration fail; tests/unit/migrations.test.ts SEED now inserts two active Fulfillments of one order to prove this, and the test passes. Prisma does not track triggers, so there is no schema drift for other tracks' migrate diff. Note for the owner: this adds a database-level constraint on the existing Fulfillment table (the task required a DB-level guard). It treats every shipment except SUBMIT_FAILED/CANCELLED as active, so a future reship after delivery/return must relax it on purpose.

**Notes:**

P4-09 done on wave3/override (commit 6c460db). Decisions:
(a) The choice is persisted in OrderWarehouseChoice and wins over routing on every re-check until cleared. Fulfill's routingChanged no longer adds the routing.changed warning when the reviewed routing is via 'manual'.
(b) The reason codes reuse ReviewReasonCode with a new kind 'warehouse' (REASON_KINDS). Groups whose stored list has no 'warehouse' code fall back to the defaults; 'other' is always accepted and needs a text.
(c) Rerouting to an euShipments connection where the order already had a shipment is refused (reroute_target_used: the reference is per order and unique per connection). FHB reships get -2, -3 suffixes as before.
(d) A reroute that the warehouse confirms returns the order to APPROVED with no new human approval: the ADMIN/OWNER request counts as the approval. The new check is stored right away, and hard findings open a 'reroute_check_failed' task. Fulfill re-validates before sending.
(e) New alert/task kinds: reroute_refused, reroute_uncertain (CRITICAL), reroute_not_approved, reroute_check_failed.
(f) New OrderEvent causes that do not change the status (from = to): warehouse_choice, warehouse_choice_cleared, reroute_requested, reroute_refused / _uncertain / _simulated. The real status move uses the new pipeline cause 'reroute'.
(g) Gap fixed in passing: validateOrder did not pass the order's product line (lineId) to routing, unlike routeOrder. Line-bound stock fallback in stored checks could therefore differ from routeOrder and add routing.changed warnings at Fulfill.
Open points:
- euShipments read-back after delete uses orders-history: Deleted/Cancelled or not found counts as confirmed (the existing adapter rule).
- FHB read-back after DELETE treats GET /order returning nothing (404) as deleted. The spec does not document 404 for GET /order, so watch the first real CANARY cancel.
- A future reship after delivery/return must relax the fulfillment_one_active trigger on purpose.

Commits: c3f8efd P4-09 audit fixes: reroute safety (shared vendor accounts, open-reroute status ownership, FHB ids, real-adapter tests)

- HIGH fixed: requestReroute and rerouteView now refuse an euShipments target (reroute_target_used) if the order already had a shipment on that connection, or on any euShipments connection that uses the same credential. The check runs before anything is queued. FHB: the new nextFhbExternalId in src/server/fhb/orders.ts, used by both submit and preview, counts the order's shipments on every FHB_V3 connection and skips ids already used. Tests: euShipments A to euShipments on a shared credential is refused with no reroute row and no delete request; FHB A to FHB B on one FHB account gets `<id>-2`.
- MEDIUM fixed (open reroute): followShipment now uses isRerouteOwnedShipment (reroute status CANCEL_QUEUED or DONE) and does not move the order for that shipment. euShipments advanceOrderStatus now passes the fulfillmentId. The shipment row still records vendor statuses. On REFUSED, finishWithout makes the order follow the shipment's current status, so it catches up. Tests: an euShipments 'Deleted' applied after the cancel was SENT leaves the order ACCEPTED, then the reroute ends DONE with the order APPROVED for B. A vendor status applied while the reroute is open plus a refused cancel ends with the order matching the shipment's status. I checked that both tests fail when the fix is reverted.
- MEDIUM fixed (fake transports): override.test.ts now runs the real euShipments and FHB adapters against mocked HTTP, so the orderDeleted / order_deleted effects run as in production. The unconfirmed-cancel test now asserts the real state after SENT: shipment CANCELLED, order ACCEPTED, refusal no_active_shipment. Both UNCERTAIN task bodies now state the shipment's real status in the CRM ('already marks the old shipment CANCELLED …' or 'still marks the old shipment <status>').
- MEDIUM fixed (FHB tests): added tests for FHB to euShipments (checks the fhb.order.delete key and payload, the effect, and that GET /order 404 confirms and the order ends APPROVED), for a read-back where GET /order still returns the order (ends UNCERTAIN, no switch), FHB to FHB on a shared account, and euShipments to an FHB target.
- LOW fixed: under the order lock, requestReroute re-reads the order status and throws reroute_not_allowed unless the 'reroute' rule allows moving to APPROVED. rerouteView reports refusal 'order_status'. Tested.
- LOW fixed: a cancel waiting in AWAITING_CONFIRMATION or PAUSED for 4 hours or more (WAITING_REMINDER_MS) opens one WARNING task, reroute_waiting, and stores its alertId. Tested.
- i18n bg/en: new error key reroute_not_allowed, new refusal key order_status, and reroute_target_used now mentions a shared euShipments account.

**Schema:** none (no migration)

**Notes:**

P4-09 audit round 2. All findings were checked and fixed; none were wrong. Remaining open items:
(1) The euShipments shared-account check compares credentialId. Two separate credential rows holding the same token are not detected, because the code does not decrypt tokens to compare them. In that case the new shipment's create is still refused by the orders-history precheck, so no duplicate is created, but the cancel at the old warehouse has already happened. Operators should not save one euShipments token twice.
(2) The FHB delete read-back treats only GET /order 404 (null) as 'deleted'. This is not documented in fhb-kika-v3.md. If FHB still returns the order after DELETE, every FHB reroute ends UNCERTAIN after 10 read-backs and the order is not switched. That is safe but needs manual follow-up. Before the first CANARY FHB reroute, record a real read-only GET /order fixture for a deleted order and adjust the rule in src/integrations/fhb-v3/adapter.ts to match.
(3) While a reroute is CANCEL_QUEUED, vendor statuses update the shipment row but not the order. If the cancel is REFUSED, the order follows the shipment's current status again. If it ends UNCERTAIN, the order stays where it was until a person resolves it.
(4) Not done (LOW, optional): letting the requester or an OWNER withdraw a waiting reroute and refuse its not-yet-sent outbox request. For now a 4-hour reminder task (reroute_waiting) points to the CANARY confirmation. Suggest a follow-up backlog item.
(5) The FHB id suffix is now counted across all FHB connections of the order. Orders that only ever had shipments on one connection get the same ids as before.


## P5-01..03 Stock, inbound, inventory push

Commits: 5c0bd3a P5-01..P5-03: stock board per master product, inbound creation (picker + XLSX/CSV), Shopify inventory push (branch wave3/stock, worktree /home/user/wt/w3-stock, not pushed)

- P5-01
- P5-02
- P5-03

**Schema:** I added one migration, prisma/migrations/20261102191717_stock_inbound_inventory_push. It only adds things and is wrapped in BEGIN/COMMIT. It creates five new tables, each with forced RLS and an account_isolation policy: StockSettings (one per account), StoreLocation, ShopifyInventoryLevel, InventoryPush and InventoryPushLine. No column was added to an existing table. The new models sit in one block at the end of prisma/schema.prisma under the banner "wave 3 · stock track". I also added back-relation lines on Account (stockSettings, inventoryPushes), Store (locations, inventoryLevels, inventoryPushes), FulfillmentConnection (storeLocations) and StoreVariantLink (inventoryLevels). The migration is applied to the shared dev DB, and tests/unit/migrations.test.ts passes.

**Notes:**

BACKLOG: mark P5-01, P5-02 and P5-03 [x]. Branch wave3/stock (worktree /home/user/wt/w3-stock), one commit, 5c0bd3a. Nothing was pushed. All data is synthetic.

DECISIONS

P5-01, stock board (src/server/stock/board.ts, levels.ts, discrepancies.ts, settings.ts; UI at /products/stock)
- /products/stock is now the master-product board for the sidebar line.
  - One column per warehouse connection (FHB / euShipments, in company scope). Each cell shows sellable, then physical · free · CRM-reserved, plus snapshot age and source; stale data is marked.
  - One "Shopify · CODE" column per store, plus total sellable and state.
  - Tabs: Наличности / Движения / Комплекти / Архив / Известия.
  - Search: name, SKU, warehouse vendorId/vendorCode/vendorEan, our EAN, Shopify SKU. EAN is a search term only.
  - Quick filters with counts: Всички, С наличност, Нулева, Тестери, Свършват до N дни, Разминаване със Shopify.
  - Testers are sorted under their original (parentProductId). 50 per page, computed over up to 5000 masters.
  - Right panel: codes per warehouse, with "реален, от склада" when the vendor EAN differs from ours; EAN history (ProductEan note/source/date); stock per warehouse, with euShipments split per physical warehouse; Shopify per store and location; open inbound lines; last 10 movements; 30-day sales and days left.
- The old FHB-only StockBoard component is unchanged and still serves the /warehouses/fhb/[id] stock tab. Its "Несвързани" filter (unlinked FHB vendor products) is now only on that tab.
- CRM reservation is computed on read and nothing writes StockLevel.reserved, so the vendor pre-flights keep their current behaviour. It counts:
  - APPROVED orders with no active shipment, at OrderCheck.connectionId;
  - FulfillmentLines of shipments that are QUEUED or SUBMITTING.
  - Orders the warehouse has already accepted are not counted, because they are already inside the vendor's free quantity.
  - sellable = max(0, min(free, physical − reserved)).
- "Свършват до N дни" = sellable ÷ (units sold in 30 days ÷ 30) ≤ N, counting every order not CANCELLED.
- Shopify mismatch uses the store's mapped locations (location quantity vs that warehouse's sellable). With no mapping it compares the store total with total sellable. The threshold is StockSettings.shopifyThreshold (default 2).
- Discrepancy alerts come from the cron stock.discrepancies (:25/:55):
  - stock_shopify_oversell (StoreVariantLink): Shopify shows more than sellable + threshold;
  - stock_snapshot_stale (FulfillmentConnection): defaults FHB 2 h, euShipments 30 h;
  - stock_negative_sellable (VendorProduct);
  - stock_unexplained_drop (VendorProduct, INFO): an FHB "out" movement in the last 24 h with no order and no stock_receipt.
  - Each is raised once per entity and auto-resolved with an AlertNote. After someone resolves one, it is not raised again for 24 h.
- SPEC §6.3 also lists "vendor free drops without a CRM order". It is covered only by the FHB movement rule above; euShipments gives only daily snapshots with no movements.
- StockSettings (shopifyThreshold, fhbStaleHours, euStaleHours, runOutDays): new permission stock.settings (OWNER/ADMIN), audited as stock.settings. The form is on the Известия tab.

P5-02, inbound (src/server/stock/inbound.ts; UI at /inbound, /inbound/new, /inbound/[id])
- One form for both vendors. Lines come from a product picker and/or an XLSX/CSV upload, read with the existing src/lib/xlsx readTable (2 MB, up to 1000 lines).
  - Columns are SKU and quantity; a header row is optional and duplicate codes are summed.
  - A code matches our SKU first, then the warehouse's vendorId/vendorCode at that connection. EAN is never used.
  - Masters outside the line, and masters not present at that warehouse, are reported per row.
- Creation goes only through the existing vendor services:
  - FHB: createFhbStockReceipt;
  - euShipments: queueEuBooking, with a required euShipments warehouse taken from EushipmentsWarehouse.
- The request token is minted with randomUUID when the page renders. The same token always gives the same receipt or booking:
  - FHB: the receipt id is derived from the token by the existing code;
  - euShipments: the booking document number is IN-<16 hex of sha256(account, connection, token)>, and a duplicate_reference returns the existing inbound.
- Detail page: expected vs received vs difference per line, the warehouse comment, the outbox requests behind it, and its tasks.
- FHB received quantities: the cron stock.inboundSweep (:10/:40) reads GET /stock-receipt (read-only) for our receipts that FHB already holds (last 120 days) and calls the existing applyFhbStockReceipt.
- New tasks on InboundShipment:
  - fhb_inbound_discrepancy: FHB moved the receipt out of `created` (the only status FHB documents) and some line has received ≠ expected;
  - inbound_overdue: nothing received 3 days after the expected date (both vendors).
  - Both auto-resolve when the condition clears. euShipments differences stay with the existing eushipments_inbound_discrepancy task.

P5-03, Shopify inventory push (src/integrations/shopify/inventory.ts, src/server/stock/shopify-inventory.ts, push.ts; UI at /stores/[id]/inventory, linked from the store page)
- Schema checked against Admin API 2026-10 with the Shopify MCP schema tool:
  - locations(first, after, includeInactive, includeLegacy) {id name isActive fulfillmentService{handle}};
  - location(id).inventoryLevels(first, after) {quantities(names), item{id tracked variants(first)}};
  - nodes(ids) on InventoryItem {inventoryLevel(locationId){quantities}};
  - inventorySetQuantities(input: {name, reason, referenceDocumentUri, quantities[{inventoryItemId, locationId, quantity, changeFromQuantity}]}) → {inventoryAdjustmentGroup{id}, userErrors{code field message}}.
  - Since 2026-04 the @idempotent(key:) directive is REQUIRED on this mutation (2026-10 docs). `ignoreCompareQuantity` no longer exists; changeFromQuantity is the compare-and-set value and we always send it.
- Read side: the cron stock.shopifyInventoryTick (:05/:35) queues stock.shopifyInventory per store whose connection test passed. It writes StoreLocation and ShopifyInventoryLevel. A missing scope (ACCESS_DENIED or auth_failed) is logged, not retried.
- Mapping: one Shopify location ↔ one warehouse per store. New permission inventory.push (OWNER/ADMIN), audited as inventory.location_mapped.
- Preview (dry run, from the mirror): target = max(0, sellable − Store.inventoryBuffer).
  - Lines are skipped when the variant has no product, is not stocked or not tracked at the location, the product is not at the warehouse, or there is no snapshot or a stale one.
  - Stale or missing data is never pushed.
- InventoryPush is its own outbox, with at most one open push per store.
  - The sender reads Store.inventoryPushMode at send time: DISABLED → REFUSED; DRY_RUN → reads current Shopify quantities and records the exact {mutation, batches[{idempotencyKey, input}]}; LIVE → sends.
  - The account kill switch or OUTBOX_PAUSED → PAUSED.
  - Batches are 100 quantities, each with a deterministic UUID-shaped key per (push, batch, generation). The variables are stored before the first send, and every retry re-sends the stored variables under the same key.
  - Unknown outcome: the quantities are read back. Lines at their target count as applied; otherwise it retries with backoff and becomes FAILED plus a task after 5 attempts.
  - CHANGE_FROM_QUANTITY_STALE marks the line stale; the next push starts from fresh numbers. IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED bumps the generation. Definite rejections (auth or definite GraphQL codes, invalid item, …) give FAILED plus an inventory_push_failed task on the Store.
  - A crashed SENDING row is re-armed to PENDING by the sweep. This is safe because the key and the compare-and-set values protect it.
- The cron stock.inventoryPushSweep (:20/:50) creates a push for every store in DRY_RUN or LIVE with a mapped active location, then queues the due pushes. "Изпрати сега" on the store page creates one by hand (audited as inventory.push_queued).
- The default store mode stays DISABLED. Raising it is still the existing OWNER-only store setting. The API watcher's existing LIVE → DRY_RUN demotion applies here too.

OPEN QUESTIONS AND GATES
1. GATE P1-G1 / Shopify app: the app needs read_locations, read_inventory and write_inventory (SPEC §4 lists read_inventory and write_inventory; read_locations is also needed). Until then the Shopify columns stay empty and the read job only logs.
2. FHB stock-receipt statuses other than `created` are undocumented. The discrepancy rule assumes that any other status means FHB is receiving or has received. Confirm the real values with the first real receipt (GATE P2-G1).
3. Owner: is a 2-unit Shopify difference threshold right? Are 2 h (FHB) and 30 h (euShipments) the right staleness limits? Is 3 days right for "overdue"? All are editable on Известия, except the 3 days.
4. The push sets Shopify "available", not "on_hand". Confirm this is what the stores want.

LEFT OUT / FOLLOW-UPS
- The auditor subagent was not run (no agent tool in this run). Audit wave3/stock before merging.
- Inbound edit and delete for FHB receipts still in `created`: the services updateFhbStockReceipt / deleteFhbStockReceipt exist but have no UI yet. There is also no "resubmit" button for SUBMIT_FAILED receipts (the service resubmitFhbStockReceipt exists).
- Push DRY_RUN_RECORDED rows pile up: one every 30 min per DRY_RUN store, and only when something changes. A cleanup job may be wanted later.
- Pre-existing flaky test: src/server/outbox/outbox.test.ts:228, findMany without orderBy (not my file).
- Merge notes: expect small conflicts in tools/e2e.ts, queues.ts, handlers.ts, rbac.ts/rbac.test.ts, messages/*.json (namespace "stock"), the end of prisma/schema.prisma, alerts.ts companiesOf, and stores/[id]/page.tsx (header actions).

Commits: 573c19b P5-01..P5-03 audit fixes: reserve every order not yet at a warehouse, expire stale push plans, same-company location mapping, alert suppression only after a person resolves

- HIGH crmReservations (src/server/stock/levels.ts): every order not yet at a warehouse is now reserved. That covers IMPORTED, CHECKING, NEEDS_REVIEW, READY, APPROVED, SUBMIT_FAILED, ON_HOLD and BLOCKED orders with no active shipment. A routed order is reserved at the warehouse in OrderCheck.connectionId. An unrouted order is reserved at every warehouse with a non-archived VendorProduct for the product. ACCEPTED and PROCESSING shipments are also reserved when their accept time (submittedAt, or updatedAt if that is missing) is later than the snapshotAt of that (connection, product). The push, the board and the discrepancy sweep all use this. Tests: a NEEDS_REVIEW order (routed or unrouted) lowers the push target; an euShipments shipment accepted after the snapshot lowers it, and one accepted before the snapshot does not.
- MEDIUM push plans frozen at create (src/server/stock/push.ts): a row with no stored request that is older than PUSH_PLAN_TTL_MS (30 min) ends FAILED with lastError plan_expired, and this is checked in the claim before the pause check, so an old PAUSED row is never re-armed. Before building the request, run() re-plans; if any line's target or connection differs, or a line is gone, the push ends FAILED plan_expired and nothing is sent. No operator task is opened for this. sweepInventoryPushes expires old unbuilt PENDING/PAUSED rows first, so a fresh push is created in the same sweep. Tests: PAUSED, then warehouse free drops, then unpause gives FAILED plan_expired with no InventoryPush call, and the next push sends the new target (4). A TTL-expired PAUSED row is replaced by the sweep.
- MEDIUM setLocationConnection (src/server/stock/shopify-inventory.ts): the connection must belong to the store's company or to a company on the same product line (the new storeConnectionCompanies helper). Otherwise it throws DomainError connection_other_company, with bg and en messages added. The connection picker on src/app/(app)/stores/[id]/inventory/page.tsx is filtered to those companies. Test: mapping to another company's FHB connection is refused.
- MEDIUM discrepancies suppression (src/server/stock/discrepancies.ts): a RESOLVED alert only suppresses for 24 h when it has no auto_resolve AlertNote. Test: raise, auto-resolve, the condition returns, and a new alert opens. A resolution by a person still mutes it.
- LOW stale-only push: when no line was applied and some lines came back CHANGE_FROM_QUANTITY_STALE, the push now ends FAILED with lastError 'stale_only: N line(s)' and audit inventory.push_stale, with no task opened. It is no longer recorded as SENT. A partially applied push stays SENT and records staleLines in its audit. The existing test was updated.
- LOW mapping race: setLocationConnection now turns the P2002 unique violation into DomainError location_connection_taken. Test: two concurrent mappings of different locations to one warehouse give one success and one location_connection_taken.

**Schema:** None (no migration).

**Notes:**

Wave 3 stock audit fixes, commit 573c19b on wave3/stock. (1) Reservation rule, recorded as a decision: CRM-reserved = orders not yet at a warehouse (IMPORTED/CHECKING/NEEDS_REVIEW/READY/APPROVED/SUBMIT_FAILED/ON_HOLD/BLOCKED, no active shipment) + QUEUED/SUBMITTING shipments + ACCEPTED/PROCESSING shipments accepted after the product's snapshot. An unrouted order is reserved at every warehouse that carries the product, including other companies' warehouses. This is deliberately conservative: it can hide stock in another company's shop until routing runs, but it can never oversell. (2) Push plans expire after 30 min or when a fresh plan differs, and then end FAILED with lastError plan_expired. This opens no operator task, and the next sweep re-plans. (3) A push where only stale lines came back (nothing applied) ends FAILED with lastError stale_only and opens no task. (4) A location may map only to a warehouse of the store's company or of a company on the same product line. (5) Stock alerts are suppressed for 24 h only after a person resolves them. Still open, LOW: inbound.ts sweepInboundAlerts still raises fhb_inbound_discrepancy as soon as an FHB receipt leaves 'created'. A grace period based on receivedQty not changing would need a new timestamp column (InboundLine.receivedChangedAt or similar), i.e. a schema change, so it was not done here. Revisit once GATE P2-G1 confirms the real FHB receipt statuses; the alternative is an allow-list of final statuses.


## P6-01..02 Returns + COD

Commits: 47ade5a P6-01 + P6-02: returns board and COD board (branch wave3/returns, worktree /home/user/wt/w3-returns; not pushed)

- P6-01 Returns board (Връщания): FHB rma/list + return/list + euShipments RETURNING/RETURN_RECEIVED as one list with source chips, statuses, items/condition/action, FHB return photos (fetched on request), linked CRM order/shipment, return tracking, 'returning but not received after N days' alert (setting), mark processed with a required note, reopen, notify support (existing email/Telegram providers, off when unconfigured), Начало 'Върнати за възстановяване' count
- P6-02 COD board (Наложен платеж): expected COD in local currency vs FHB cod/list (waiting/received/paid) and euShipments check-cod-by-order (registered/paid + protocol), ageing buckets 0–7/8–14/15–30/30+ days since delivery, totals by currency and by company, mismatches (amount / missing / unexpected) as auto-resolving operator tasks, CSV export
- Both boards respect the company filter, the product-line filter, restricted members' company scope and the header warehouse scope
- e2e tests/e2e/returns-cod.spec.ts passes on a production build (E2E_PORT=3104) and in dev mode

**Schema:** Migration prisma/migrations/20261102194508_returns_cod. It only creates new tables, inside BEGIN/COMMIT, each with the standard RLS policy (ENABLE + FORCE + account_isolation). No existing table or column is altered.
- ReturnCase: caseKey is unique per account; a case links to its connection with a composite FK and stores the optional fulfillment/order/company ids; it holds sources[], state RETURNING|RECEIVED, items/photos JSON, the processed mark and the support-notify fields.
- ReturnNotification: unique (returnCaseId, channel).
- ReturnPhoto: bytea, unique (returnCaseId, photoId).
- ReturnsCodSettings: one row per account; returnOverdueDays 14, codMissingDays 14, notifySupport true.
- schema.prisma: the four models are in one block at the end under the 'wave 3 returns + COD' banner. Back-relations were added to Account (returnCases, returnsCodSettings) and FulfillmentConnection (returnCases).
- The diff against the shared dev DB also showed DROP statements for other worktrees' tables (InventoryPush, OrderReroute, StockSettings, …). Those were left out of the migration.
- tests/unit/migrations.test.ts passes.

**Notes:**

BACKLOG: mark P6-01 and P6-02 [x]. Both are in one commit because they share the settings model, the migration and the sweep worker.

DECISIONS
- Returns are stored as ReturnCase rows. They are built by the returns.sweep cron (every 10 min) from the local mirrors only: FhbOrderMirror inRma/returnedAt, FhbReturnMirror, and Fulfillment status RETURNING/RETURN_RECEIVED with their FulfillmentEvents. The sweep never calls a vendor.
  - There is one case per CRM shipment (caseKey fulfillment:<id>). sources[] lists every source that describes the same parcel, e.g. FHB_RMA + FHB_LOCAL.
  - Returns the CRM cannot link keep a vendor key: fhb-rma:<conn>:<externalId> or fhb-return:<conn>:<uid>.
  - An FHB local return is linked by package barcode = the shipment's tracking or return tracking number, on the same connection only. EAN is never used.
  - The sweep is idempotent (order-insensitive JSON comparison). A case never goes back from RECEIVED to RETURNING, dates only move earlier, the operator's processed mark is kept, and cases are never deleted.
  - Known gap: if an unlinked case later becomes linkable, a second case is created under the shipment key. This should be rare and is not re-keyed.
- FHB has no 'on the way back' status. An FHB case is RETURNING only when the shipment carries package_returns before returned_at. In practice every FHB case is RECEIVED, and the overdue alert mostly concerns euShipments.
- Item condition and action come only from FHB local returns of type complex. RMA and euShipments cases show the CRM order lines (or FHB product ids for orders that are not in the CRM).
- Overdue alert:
  - kind return_overdue, WARNING, a task, entity Fulfillment, so the company scope and the order link work;
  - raised when a case is still RETURNING after returnOverdueDays (default 14), measured from the first RETURNING event, else from when the CRM first saw the case;
  - resolves itself with an auto_resolve note once the parcel is received or the case is processed.
- Processed:
  - needs returns.manage and a note of 2–1000 characters;
  - written as a conditional write (already_processed on a second try);
  - resolves the shipment's open return_overdue and eushipments_return_received tasks with an AlertNote;
  - audited as return.processed; reopen is audited as return.reopened.
- Support notification:
  - uses the existing P4-08 emailProvider and telegramProvider;
  - optional separate recipients: RETURNS_SUPPORT_EMAIL_TO and RETURNS_SUPPORT_TELEGRAM_CHAT_ID; otherwise ALERT_EMAIL_TO / TELEGRAM_CHAT_ID;
  - a channel that is not configured is off: nothing is sent or recorded;
  - sent automatically only for returns the warehouse dated within the last 3 days, so the first sweep after deploy does not send the history; undated or older returns go out from the 'Уведоми поддръжката' button;
  - once per case and channel (ReturnNotification claim); a FAILED channel is retried only on a manual request;
  - the message holds the order number, the warehouse name and a link to /returns?case=<id>, never customer data;
  - setting notifySupport turns the automatic sending off.
- FHB return photos:
  - the worker downloads them only when an operator clicks 'Зареди снимките' (queue returns.photos, GET /return/{uid}/photo/{id});
  - images only (jpeg/png/webp/gif), at most 5 MB each, stored in ReturnPhoto;
  - served by /api/returns/photos/[id] with the board's scope rules, nosniff and a sandbox CSP;
  - no vendor call is made from a route handler.
- COD board:
  - one row per shipment in SHIPPED/DELIVERED/COD_PAID created in the last 365 days;
  - expected = Order.codLocalAmount/codLocalCurrency, falling back to codAmount/currency;
  - FHB data: FhbCodMirror (waiting/received/paid; any other value is shown raw as 'unknown');
  - euShipments data: EushipmentsTracking; codAmount present = 'registered' (shown as received from the carrier), codPaidAt or COD_PAID = paid, with the payout protocol;
  - ageing is in UTC days since deliveredAt (0–7, 8–14, 15–30, 30+); not delivered = in transit;
  - mismatch 'amount': the vendor amount differs from the expected amount (compared in cents);
  - mismatch 'missing': delivered at least codMissingDays ago (default 14) with no vendor record; for euShipments only after check-cod-by-order has answered;
  - mismatch 'unexpected': FHB reports cod > 0 on a prepaid order.
  - The cod.sweep cron (hourly at :37) turns mismatches into tasks cod_amount_mismatch, cod_missing and cod_unexpected (entity Fulfillment, WARNING), one per shipment and kind, and resolves them itself once the data match.
  - CSV via /api/cod/export uses the same filters as the screen and holds no customer names (writeCsv guards against formula injection).
- Settings (ReturnsCodSettings): returnOverdueDays, codMissingDays and notifySupport, edited on the Returns page by account.settings (OWNER/ADMIN) and audited as returns_cod.settings.
- New permissions: returns.manage (OWNER, ADMIN, OPERATOR, WAREHOUSE) and cod.read (OWNER, ADMIN, OPERATOR). The COD page returns 404 for WAREHOUSE and VIEWER.

BEHAVIOUR CHANGE ON DEPLOY
- The first returns.sweep creates cases for every return already in the mirrors, and return_overdue tasks for euShipments returns that have been on the way more than 14 days.
- The first cod.sweep raises tasks for existing COD mismatches.
- No support message is sent for returns older than 3 days.

OPEN QUESTIONS FOR THE OWNER
1. Which address or chat should support get (RETURNS_SUPPORT_EMAIL_TO / RETURNS_SUPPORT_TELEGRAM_CHAT_ID on the Render worker)?
2. Are 14 days the right defaults for both thresholds?
3. SPEC §11.6 is still open: is FHB's local returns service active? If not, return/list stays empty and there are no photos.

FOLLOW-UPS
- The returns sweep re-reads every RETURN_RECEIVED shipment every run. That is fine at current volume; add a window or cursor if it grows.
- An FHB shipment that is DELIVERED but has no deliveredAt never becomes 'missing'.
- The FHB mirror page keeps its own COD and RMA tabs; the new boards are the cross-warehouse view.
- INTEGRATION_NOTES §2.5 could add one line: return photos are fetched on request by the worker.

Commits: 7dce0b6 P6-01/P6-02 audit fixes: COD missing only when the warehouse was actually read, no false auto-resolve, stale support claims, streamed photo cap, scoped home count

- Audit MEDIUM 1 fixed: an FHB 'missing' COD now needs proof the warehouse data was read. The last good cod/list run (FhbSyncState resource 'cod', lastOkAt) must have covered the shipment, meaning it was created within WINDOWS.codDays (120) before that run, and that run must be at least codMissingDays after delivery. classifyCod gets this as fhbCodCheckedAt. Rows the run did not cover show the new state 'not_covered' (bg/en i18n). Regression tests: an FHB shipment created 200 days ago with no mirror row raises no task, and a connection whose cod sync never ran raises no task.
- Audit MEDIUM 2 fixed: sweepCodMismatches resolves a task only when it re-evaluated that task's shipment in this run. Shipments of open tasks that the two board queries did not return are re-checked by id. Tasks whose shipment is still not evaluated stay open: past the 365-day look-back, past the 20k row cap, or moved to a status outside the board. Regression test covers both ageing past LOOKBACK_DAYS and a move to RETURN_RECEIVED; the task resolves only once the shipment is back on the board and its COD matches.
- Audit MEDIUM 3 fixed: loadRows now selects eushipmentsTracking.lastError. If a row has lastError and no codAmount, it does not count as an answer (vendor.checkedAt becomes null). Pure test and sweep test cover the failed check-cod-by-order path; the task appears only after lastError is cleared.
- LOW notify fixed: at the start of notifySupportForAccount, SENDING claims older than 10 minutes (wall clock) become FAILED, so the manual button can retry them. A FAILED→SENDING re-claim now resets createdAt, which works as the claim time. Test added.
- LOW FHB binary cap fixed: the client reads res.body in chunks, keeps a running total, and cancels the stream and throws as soon as the total passes maxBytes. Test with an endless chunked stream that has no Content-Length.
- LOW home count fixed: countReturnsToProcess takes connectionTypes, and the Начало page reads SCOPE_COOKIE and passes it, the same as /returns. Test added.
- e2e seed now records a successful FHB cod sync state, which #CD-3 'Липсва в склада' depends on.

**Schema:** None (no Prisma schema or migration change).

**Notes:**

P6-01/P6-02 audit fixes (branch wave3/returns, commit 7dce0b6):
- COD 'missing' now needs the warehouse to have actually answered at least codMissingDays after delivery.
  - FHB: the last good cod/list run (FhbSyncState lastOkAt) must cover the shipment, meaning it was created within WINDOWS.codDays before that run.
  - euShipments: codCheckedAt counts only if it is not a failed check (lastError set and no amount).
  - Rows that no run covered show 'not covered' (не е четено от склада).
- The COD sweep auto-resolves only tasks whose shipment it re-evaluated (open-task shipments are re-checked by id). Tasks for shipments outside the window or the row cap, or with a changed status, stay open.
- Known limits:
  - eushipmentsTracking.lastError is shared with the tracking poll. A tracking error left on a row whose COD check answered 'no COD' suppresses 'missing'. This only means a missing alert is not raised (no false alert). A dedicated codError column would remove it if needed.
  - An FHB mirror row that has aged out of the 120-day cod/list window keeps its last known state (e.g. 'received'), so it can stay outstanding without moving to 'paid'. It no longer raises false tasks.
- Support notification: SENDING claims older than 10 minutes become FAILED (retryable via 'Уведоми поддръжката'). A re-claim resets createdAt, which is used as the claim time.
- FHB photo reads stream with a running 5 MB cap.
- The Начало 'Върнати за възстановяване' count follows the header warehouse scope.


## P7-01..03 Joy labels, AWBs, manual shipments

Commits: 177e1b1 P7-01 + P7-02: FHB Joy labels and euShipments AWB services behind the outbox (server side); 7e68d62 P7-03: Ръчни пратки и етикети — manual shipment form, label screens, bulk label PDF; 31f1381 Keep docs/screens unchanged (regenerated by a local shell e2e run); 24f3ea3 P7-01: read-only FHB Joy live check (login, delivery points, newest label) + as-built notes for Joy and AWBs

- P7-01
- P7-02
- P7-03

**Schema:** One migration, prisma/migrations/20261102202157_manual_shipments_labels. It is additive only: five NEW tables with forced RLS (account_isolation) and no column change on any existing table.
- ManualShipment: orderId, kind WAREHOUSE|JOY_LABEL|AWB|PRE_AWB, connectionId, fulfillmentId, params, tracking state, clientRequestId; unique (accountId, orderId), (accountId, fulfillmentId), (accountId, clientRequestId).
- ManualShipmentSequence: accountId PK, next default 1001.
- ShipmentLabel: PDF/ZPL bytes in the DB, sha256, single|bulk, fulfillmentIds.
- LabelPrintJob.
- ShippingQuote.
Back-relation lines were added to FulfillmentConnection (manualShipments, shipmentLabels, labelPrintJobs, shippingQuotes), Order (manualShipment) and Fulfillment (manualShipment, labels). The schema block is appended at the end of the file under a wave-3 labels banner, and prisma format was NOT run, so the rest of the file has no formatting churn.
The migration is already applied to the shared dev DB. While iterating I dropped and re-created only my own five tables (they were empty) and their _prisma_migrations row. tests/unit/migrations.test.ts and the tenant-isolation test pass.

**Notes:**

BACKLOG: mark P7-01, P7-02 and P7-03 [x].

DECISIONS
1. Every manual shipment is a MANUAL Order.
   - Its number comes from a per-group sequence (M1001, M1002, …). The external id is `M-<number>` at every vendor: Joy id, FHB order id and euShipments reference.
   - Store codes are short and Shopify numbers are numeric, so `M-M1001` cannot collide with a store's order id.
   - src/server/fhb/orders.ts now uses code "M" for MANUAL orders with no store (submit and preview), via a new orderCode() helper.
2. WAREHOUSE kind ("from stock"):
   - The order is created IMPORTED and checkOrder runs with the chosen connection: the same validator engine, routing explanation and stock check as any order.
   - The operator then uses the existing review → approve → Fulfill on /orders/[id]. Nothing new can send a vendor order.
3. Label kinds (Joy label, euShipments AWB, pre-AWB):
   - Nothing is written on a hard finding, and unseen soft findings need an acknowledgement.
   - One transaction then creates the order, an OrderCheck (fingerprint), the pipeline walk (check_start → check_result → approve → queue, all strict, meta.labelFlow) with OrderEvents, the Fulfillment (unique per connection and externalId) and the outbox row.
   - New pipeline guards (src/server/labels/pipeline-guard.ts, registered from src/server/pipeline/index.ts) refuse check_start, approve and queue for label-only orders outside that flow, so a re-check or the Fulfill button can never route them to a stock warehouse.
   - checkOrder on such an order still re-validates and stores a check, but the status does not move.
4. A double click on the form is one shipment: a per-form clientRequestId (unique), plus the Fulfillment and outbox unique keys.
5. FHB Joy:
   - No test mode, so DRY_RUN only records and labels leave only in CANARY (click + daily cap) or LIVE.
   - GET /shipment?id= runs before every real create; a 409 or timeout is read back; a recovery re-fetches the label by reprint.
   - The label PDF is stored in ShipmentLabel, never in the outbox row.
   - Status `rejected` → CANCELLED.
   - Joy has no endpoint listing the parcel services enabled for an account, so an admin enters the codes (and the pickup-only codes) on the FHB_JOY connection, stored in vendorIds.
   - Joy connections are created and managed on /manual-shipments (OWNER/ADMIN). They start READ_ONLY; raising the mode goes through setConnectionMode, which is OWNER-only and audited.
6. euShipments AWB:
   - createAWB and preAWB use testMode in DRY_RUN. Neither has a read-back by reference (waybills-history is by AWB only), so an unknown outcome is UNCERTAIN plus an outbox task and is never retried. Delete reads back via waybills-history.
   - The labels transport is composed onto the euShipments transport (withAwbOperations) in src/worker/main.ts.
   - EuShipmentsClient http/write/read changed from private to protected so EuAwbClient can extend it.
   - An AWB Fulfillment gets an EushipmentsTracking row with stopPolling=true, so the fulfilment-order poller never looks it up by reference.
   - Tracking is the new labels.sweep cron (every 10 min). It reuses applyOrderHistory with waybills-history items and the same status table, and also tracks Joy via GET /shipment.
   - The AWB label is fetched by print/{awb} after creation.
7. Bulk label PDF uses the vendor bulk endpoints (Joy GET /labels ≤100, merged/print ≤50): one PDF per connection, read jobs only. No PDF library was added.
8. A read-only FHB Joy live check is registered for P9-02.

FOLLOW-UPS / OPEN
- The "+ Създай" header menu still shows "Ръчна пратка" disabled. I did not touch HeaderControls.tsx, to avoid conflicts with the inbound track. Link it to /manual-shipments/new at merge.
- Joy `_embedded.notifyLinks` callbacks are not sent; tracking is polled every 30 min.
- Joy /packages (async flow) is in the client but unused. Packing lists, anonymization, AWB pallet / NON-EU / pickup variants and INOUT label pre-AWBs are not built.
- Pre-AWB orders are not tracked: there is no AWB until euShipments creates one, and no documented lookup.
- The AWB label fetch in labels.sweep retries every 10 min with no cap when print keeps failing.
- Ask euShipments at GATE P3-G1 what createAWB / preAWB return with testMode:true (treated as a pass when there is no error text).
- GATE P2-G1 now also covers entering the Joy credentials and the parcel-service codes from ZOE on /manual-shipments.
- The auditor subagent was not available in this run; audit the three commits before merging.

Commits: ace923b P7 audit fixes: declared value currency, label-only orders kept out of Fulfill, duplicate labels, Joy id conflicts, connection company

- HIGH awb declaredValue currency: hard awb.declared_value.currency when declaredValue>0 and no local currency or currency != local (independent of COD), plus awb.declared_value.negative; awb.test.ts covers prepaid foreign currency, missing CountrySetting, local currency passes
- MEDIUM label-only orders in Fulfill: isLabelOnly() exported from labels/pipeline-guard; fulfillOrder returns BLOCKED label_only_order, queueEuOrder and submitFhbOrder throw DomainError('label_only_order'); test: QUEUED AWB order (DRY_RUN recorded) -> fulfillOrder BLOCKED, queueEuOrder rejects, no new Fulfillment/outbox row
- MEDIUM duplicate labels: soft manual.duplicate_recipient (same company, not cancelled, same amount, 48h window, same phone OR email OR address1+zip) in label preview, fast-fail gate and again inside the create transaction under the connection lock; WAREHOUSE preview now passes real duplicates to orderLevelFindings; clientRequestId required for create (client_request_id_required); form uuid() falls back to getRandomValues/Math.random so it is never undefined; tests for needs_ack across two different clientRequestIds, address match, missing id
- MEDIUM Joy id conflict: sameJoyShipment() compares variableSymbol, normalised zip, name, COD (GET /shipment fields from the reference; JoyShipmentInfo now types name/zip); send() pre-create and 409 path return rejected + create_rejected{idConflict} -> CRITICAL task labels_joy_id_conflict and SUBMIT_FAILED; readBack throws -> UNCERTAIN + outbox operator task; adapter test + integration test
- MEDIUM connection vs order company: loadConnection requires connection.companyId == order company (or null) for label kinds -> connection_other_company; WAREHOUSE gets soft manual.connection_other_company in preview and must be acknowledged at create; tests for both
- LOW euCouriers/euOffices: assertCan orders.fulfill + company-scope check of the connection (officesAction maps refusals to []); labelForDownload requires orders.fulfill or stock.manage (VIEWER refused, WAREHOUSE allowed); test
- LOW Joy note 250: kept as CRM limit, documented in schemas.ts comment and INTEGRATION_NOTES §3
- LOW applyJoyInfo forward-only: joyStatusMovesForward(); stale 'pending' after 'sent' keeps SHIPPED, stores raw; test
- LOW AWB print retries: ManualShipment.labelAttempts/labelError (new additive migration), awbLabelsMissing filters < MAX_LABEL_ATTEMPTS (6), fetchMissingAwbLabel counts failures and opens one labels_awb_print_failed task via alertOnce; test
- bg/en messages for the new error codes under the manual namespace; e2e seed passes clientRequestId

**Schema:** ManualShipment (wave-3 labels block): + labelAttempts Int @default(0), + labelError String?. Migration prisma/migrations/20261102215204_manual_shipment_label_attempts (BEGIN/COMMIT, additive, NOT NULL column has a default). Applied to the shared dev DB.

**Notes:**

P7 audit fixes (wave3/labels, commit ace923b). All findings were checked and found correct, and every one is fixed with a regression test. (1) AWB declaredValue must be in the local currency even when there is no COD: hard finding awb.declared_value.currency. (2) Label-only manual orders are now refused explicitly by fulfillOrder, queueEuOrder and submitFhbOrder with label_only_order. The pipeline queue guard is skipped by transition()'s QUEUED->QUEUED 'same' short-circuit; transition.ts was left unchanged. (3) New soft finding manual.duplicate_recipient: same company, same amount, within 48 h, matched on phone, email, or address1+zip. It must be acknowledged, and it is re-checked under the connection lock. clientRequestId is now required to create a manual shipment, while previews and resend do not need it. (4) Joy: a shipment found under our id is accepted only if variableSymbol, zip, name and COD match. Otherwise send() rejects it and opens a CRITICAL task (labels_joy_id_conflict), and readBack throws, which makes the outbox request UNCERTAIN. (5) A label must use a connection of the order's company (connection_other_company). For WAREHOUSE, another company's warehouse gives the soft finding manual.connection_other_company. LOW items: (a) mirror lookups and label downloads now check scope and RBAC; label download is allowed for orders.fulfill or stock.manage, so WAREHOUSE staff can print. (b) Joy tracking status only moves forward. (c) AWB print retries stop after 6 attempts and open one labels_awb_print_failed task; manual reprint still works. (d) The Joy note limit of 250 is documented as a CRM limit. Follow-ups: there is no UI action yet to reset labelAttempts after the task is resolved, and the new codes in the fulfill namespace (label_only_order) fall back to the generic fulfill error text because that namespace is not ours.


## P8-01..04 AI reviewer

Commits: 2e6d01a P8-01..P8-04 AI domain: review embeddings + pgvector retrieval, Claude reviewer with strict tool output and full log, AiPolicy L0-L2 with promotion/demotion, audit sample, kill switch, rule mining; 9afa168 P8-02..P8-04 AI screens: dashboard, autopilot audit, rule proposals, prompt/response log, AI card on the order detail; e2e with the model mocked

- P8-01
- P8-02
- P8-03
- P8-04

**Schema:** One additive migration, prisma/migrations/20261102202643_ai_reviewer. It adds new tables only, all with RLS (account_isolation policy): AiControl, AiInteraction, AiSuggestion, ReviewEmbedding, AiAuditSample, AiPolicyEvent, AiRuleProposal.
- AiControl: the group kill switch, unique per accountId.
- AiInteraction: the full prompt/response log.
- AiSuggestion: the AI's suggestion plus the outcome fields. It has @@unique([accountId,id]) and a composite FK to Order.
- ReviewEmbedding: vector(1024), unique per (reviewId, provider). The FK to Review is on id only, because Review has no (accountId,id) key. A trigger, crm_review_embedding_same_account, keeps each embedding in its review's account.
- AiAuditSample: composite FK to AiSuggestion.
- AiPolicyEvent and AiRuleProposal: plain new tables.

No existing table or column is changed. The schema only gains back-relation lines: 7 on Account, aiSuggestions on Order, embeddings on Review. The new models are in one block at the end of schema.prisma under the banner 'Wave 3 · track "ai"'. The existing Review.embedding column is left unused; vectors live in ReviewEmbedding so each one records its provider. There is no ANN index: retrieval is an exact cosine search per group, which is fine at current volume, and adding HNSW later would cause Prisma drift. tests/unit/migrations.test.ts passes.

**Notes:**

BACKLOG: mark P8-01, P8-02, P8-03 and P8-04 [x]. GATE P8-G1 stays open. Branch wave3/ai, worktree /home/user/wt/w3-ai. Nothing was pushed.

WHAT EXISTS
New directory src/ai/ (the layout CLAUDE.md names):
- config.ts: model ids from env. AI_REVIEWER_MODEL defaults to claude-sonnet-5-5, AI_CHEAP_MODEL to claude-haiku-5-5. AI_KILL_SWITCH=1 is the global stop.
- llm.ts: the Messages API transport.
- embeddings.ts, case-text.ts, retrieval.ts: P8-01.
- reviewer-schema.ts, prompt.ts, reviewer.ts, guardrails.ts, fields.ts: P8-02.
- policies.ts, evaluate.ts, autopilot.ts, guard.ts: P8-03.
- rule-mining.ts: P8-04.
- views.ts, jobs.ts.
- test-fixtures.ts and test-helpers.ts: tests and the e2e seed only.

UI: /ai has tabs Преглед, Одит на автопилота, Предложени правила and Лог на заявките. The order detail has an AI card (dark panel). Actions are in src/app/actions/ai.ts.

Worker queues:
- ai.review: stately, singletonKey = order id.
- ai.sweep: every 5 min.
- ai.evaluate: every 10 min.
- ai.auditSample: daily at 04:21 UTC.
- ai.ruleMining: Mondays at 05:37 UTC.

DECISIONS
1. No new dependency. Adding @anthropic-ai/sdk would be a new dependency category (CLAUDE.md says ask first), it would touch the shared lockfile, and the npm 1.x release is days old. So llm.ts calls POST /v1/messages over fetch with anthropic-version 2026-10-21, x-api-key, 2 retries on 408/409/429/5xx/529 honouring retry-after, and a 120 s timeout. It sends no temperature/top_p/top_k, which that version rejects. The LlmClient interface is mocked in tests; switching to the official SDK later only changes llm.ts.
   Tool call: forced tool_choice is refused by claude-sonnet-5-5, so the request uses tool_choice auto, `strict: true` on the submit_review tool and a prompt instruction. Zod re-validates the output.
   - stop_reason "refusal" is logged as refusal.
   - A missing or malformed call is logged as no_tool_call or invalid_output and never becomes a suggestion.
   - After 2 failures in a day an order is not retried automatically.
   - The system prompt is frozen and cached (cache_control ephemeral).
   - Effort is low for the cheap model and medium for the reviewer.
   - Sonnet requests send `fallbacks: "default"` with the server-side-fallback-2026-07-01 beta; Haiku requests send none.
   Model choice: orders with no finding go to the cheap model, orders with any finding to the reviewer model.
2. Embeddings: Voyage AI (VOYAGE_API_KEY, voyage-3.5 by default, output_dimension 1024; endpoint and fields checked against docs.voyageai.com) plus a deterministic local provider. The local one is FNV-1a feature hashing of a "case text" into 1024 dimensions, L2-normalised.
   - Every decided review always gets a local-hash vector, plus a voyage vector when the key is set.
   - Retrieval uses the first provider that has vectors, and never compares vectors across providers.
   - The case text holds shapes only (country, zip/phone shape, finding codes, corrected fields), so no name, street or full phone goes to an embedding provider.
   - Similar cases given to the model have other customers' phones and streets masked.
3. Autonomy. Decision types are order_approval (up to L2) and address_fix (up to L1, never automatic). The AI only reviews orders of a group whose order_approval policy is enabled; this is the shadow-mode switch the owner sets at GATE P8-G1.
   - Promotion: an OWNER clicks, one level at a time. The rule is re-evaluated on the server: in the window (30 days by default), at least minDecisions (≥300) compared decisions, at least minAgreement (≥98%) agreement and zero critical misses. Thresholds can only be made stricter than the SPEC.
   - Demotion to L0 is automatic, with a CRITICAL alert ai_policy_demoted, on any critical miss since the last level change, or when agreement is below the threshold with at least 50 decisions. A rejected audit sample demotes immediately.
   - A critical miss is an AI APPROVE with confidence ≥ autoConfidence (95% by default) on an order a person held or blocked, or a rejected audit sample.
   - Agreement: decisions are compared by class (APPROVE and EDIT_AND_APPROVE count as one class). Fixes agree when they equal the operator's corrections of the AI-fixable fields.
   - When a person decides, the suggestion is also copied into Review.aiSuggestion and Review.aiConfidence.
4. L1 assist means a one-click "Приложи корекциите на AI" button, not a silent pre-edit. It goes through the normal editOrderAddress path (audited, Review diff via "suggested_fix:ai.reviewer", re-check), and a person still approves.
5. L2 autopilot only APPROVES, through transition() with an AI actor. The pipeline's guard loads the AiPolicy in the transaction, and src/ai/guard.ts registers extra approve guards: ai_stopped, ai_not_ready (READY only, so any soft finding means a person) and ai_high_value.
   Further conditions:
   - the suggestion is APPROVE with no fixes, flags or guardrails;
   - its confidence is at least autoConfidence;
   - the check fingerprint is unchanged;
   - the order is not high value (default amounts per currency; a currency without an amount counts as high value).
   SENDING is not automated: autopilot-approved orders still go out through Fulfill and the outbox mode gate. This deviates from SPEC §7.4's "approved and submitted automatically". It is the safe reading, because the Fulfill path needs a user actor and CANARY needs a click. Open question for the owner below.
6. Guardrails: fixes are allowed only on company, address1, address2, city, zip, province and phone. A fix to the name, country, e-mail, COD, amounts or lines is dropped and noted ("fix_dropped:<field>"). If an EDIT_AND_APPROVE loses all its fixes it becomes HOLD, and an approval despite a hard finding also becomes HOLD.
7. Kill switches: AiControl.killSwitch (group, OWNER only, audited) and env AI_KILL_SWITCH=1 (global). Both stop reviews and refuse AI approvals inside the pipeline.
8. Rule mining clusters Review diffs into three kinds, each needing at least 5 distinct orders over 90 days:
   - phone_prefix (e.g. "HU: 06 → +36"),
   - zip_format,
   - value_map for city/province.
   Re-mining keeps an existing verdict. Accepting a proposal records it, opens an INFO task alert ai_rule_accepted with a markdown developer brief, and writes an audit entry. No code is generated at runtime.
9. Permissions:
   - ai.read: OWNER, ADMIN, OPERATOR (dashboard and AI card; the /ai nav item is now gated by it).
   - ai.manage: OWNER.
   - ai.audit: OWNER, ADMIN, OPERATOR.
   - ai.rules: OWNER, ADMIN.
   - ai.log: OWNER, ADMIN (the log holds customer data).
   Company scope applies to the AI card, audit samples and the log.

GATE P8-G1 (owner)
- Set ANTHROPIC_API_KEY on the Render worker (and optionally the web service: the UI only checks whether it is set).
- Optionally set VOYAGE_API_KEY.
- Then in Настройки → AI асистент click "Включи в режим сянка" for each group that should start in shadow mode.
Until the key is set, /ai and the order card show "AI е изключен: не е зададен ANTHROPIC_API_KEY". I did not add the env vars to render.yaml (other tracks did not either); they are only commented in .env.example.

OPEN QUESTIONS FOR THE OWNER
1. Should L2 autopilot orders also be submitted automatically, or stay "approved, then Fulfill"?
2. Are the high-value default amounts right? EUR 300, BGN 590, RON 1500, HUF 120000, CZK 7500, PLN 1300.
3. The full prompt/response log keeps customer data with no retention limit. It should follow the GDPR retention setting once that exists.

FOLLOW-UPS
- Run the auditor subagent on wave3/ai.
- The ai.evaluate cron scans decided reviews of the last 3 days every 10 min. Fine at current volume; index or cursor it if review volume grows.

Commits: 747a73d P8 audit fixes: LLM deadline under the ai.review expiry, one suggestion per order version, demotion of paused policies, AI-applied fixes excluded from agreement and rule mining, Anthropic API reference, race-safe policy/kill-switch writes, company-scoped AI dashboard

- MEDIUM llm/queues: anthropicHttpClient now has an overall deadline (LLM_DEADLINE_MS 240 s, injectable clock). Once it is spent, no new attempt or wait starts, and each attempt's timeout is capped by the time left. ai.review expireInSeconds went from 300 to 600. reviewOrder writes the AiSuggestion inside a transaction under an advisory lock (ai.suggestion:<orderId>) and re-checks the latest fingerprint first, so a second concurrent run returns skipped/already_reviewed. Tests: deadline (2 attempts, not 3), expiry > deadline + 60 s, two concurrent reviewOrder calls leave exactly 1 suggestion.
- MEDIUM policies: demotionCause no longer skips disabled policies, and enforcePolicies also demotes disabled policies above L0. setPolicyEnabled(true) re-runs policyStats + demotionCause and drops to L0 with an alert before enabling. The demote + alert code is factored into demoteToL0. Test: L2 -> disable -> audit reject -> stays disabled at L0 -> enable -> L0, and tryAutopilot returns policy_not_l2. A second case where a critical miss is recorded while paused with no sweep: enabling demotes it.
- MEDIUM evaluate/rule-mining: compare() leaves out fields whose final change has a via starting with 'suggested_fix:ai.' (new isAiApplied). If the only changes are AI-applied, fixesAgreed is null. mineRules only uses changes with via null or 'manual'. Tests: pure compare cases for AI-only, AI plus a manual miss, and manual agreement; DB mining with 5 AI- or validator-applied zip changes yields no proposal.
- MEDIUM Anthropic reference: added docs/integrations/anthropic.md, which quotes the reference line for every header and body field sent (x-api-key, anthropic-version 2026-10-21, anthropic-beta server-side-fallback-2026-07-01, fallbacks 'default' (left out for Haiku), output_config.effort, strict tools, tool_choice auto, cache_control) and every response field read. Added docs/integrations/raw/anthropic-messages-api.md with verbatim excerpts of Anthropic's API reference from the claude-api skill bundled with Claude Code 2.1.316, plus INTEGRATION_NOTES §7 and a pointer in llm.ts. I verified every field against that reference, so nothing had to be dropped. Fixtures src/ai/__fixtures__/anthropic-messages-tool-use.json and anthropic-error-400.json follow the documented shape. Tests check the response parse, the error message and that the request uses only allowed keys.
- LOW tests: pipeline guard transition_guard:ai_high_value on a READY order with total 900; the in-transaction tryAutopilot high_value check, reached without the guardrail tag; two concurrent tryAutopilot calls on the same suggestion give exactly 1 approve OrderEvent and 1 ai.autopilot_approved audit row.
- LOW upsert: writePolicy uses upsert on accountId_decisionType, and setAiKillSwitch uses upsert on accountId. Test: two concurrent setPolicyEnabled calls and two concurrent setAiKillSwitch calls on a new group both succeed, and each table ends with 1 row.
- LOW views: aiDashboard now applies company scope to suggestions24h, the weekly trend, calls24h, failed24h and the token sums. Calls are filtered to orders in scope; AiInteraction has no order relation, so the window's orderIds are resolved first. Test: an out-of-scope member sees zeros.

**Schema:** None. No migration was needed: duplicate suggestions are prevented with an advisory lock and a re-check, not a new unique index. The upserts use the existing @@unique([accountId, decisionType]) on AiPolicy and accountId @unique on AiControl.

**Notes:**

P8 audit round 1 (wave3/ai, commit 747a73d): all 4 MEDIUM and 3 LOW findings are fixed, each with regression tests.

- The LLM client has an overall deadline of 240 s; the ai.review job expiry is 600 s.
- Suggestions are written under a per-order advisory lock with a fingerprint re-check.
- Disabled policies are demoted too, and re-enabling re-applies the demotion rule.
- AI-applied fixes (via suggested_fix:ai.*) are excluded from fixes agreement. Rule mining only uses changes with via null or 'manual', which also excludes one-click validator suggested_fix changes.
- Policy and kill-switch writes are upserts.
- The AI dashboard usage block and trend are company-scoped.

Anthropic API surface: docs/integrations/anthropic.md + raw/anthropic-messages-api.md now quote Anthropic's reference for every header and field we send. Source: the claude-api skill bundled with Claude Code 2.1.316, read 2026-11-02. Every field was confirmed there, including anthropic-version 2026-10-21, fallbacks 'default' with server-side-fallback-2026-07-01, no fallbacks for Haiku 5.5, output_config.effort, strict tools, and forced tool_choice being refused. So the fields were kept, not dropped.

The fixtures follow the documented shape and are synthetic. No real response has been recorded, because there is no key here by design. After GATE P8-G1, compare the first AiInteraction log with anthropic.md and replace the fixture with a scrubbed real response.

Possible follow-up: a read-only live check via GET /v1/models/{id} to confirm the configured model ids, added to pnpm check:live.

openProposals on the dashboard stays a group-wide count. Rule proposals are group-level rule definitions, and the count matches the Rules tab the member can open; it shows no per-company order data.

