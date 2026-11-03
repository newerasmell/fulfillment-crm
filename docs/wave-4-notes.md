# Wave 4 — as-built notes


## P10-01/02 Товарителници + Тикети от склада

Commits: 6b1493c P10-01 Товарителници + P10-02 Тикети от склада

- P10-01 Товарителници (/shipments): one list of every Fulfillment row (FHB, FHB Joy labels, euShipments, the shipments behind manual shipments, rerouted/cancelled). Each row shows: order link + customer, company + line chips, warehouse chip + connection + country, carrier name (from FhbCarrier / EushipmentsCourier; an unknown code is shown raw), tracking numbers with links (only http/https, paired per number), our status + raw vendor status (muted), delayed/rerouted/ticket badges, manual-kind badge, COD in local currency (cod.read roles only), created/submitted/shipped/delivered dates, age. Status chips with counts (В подготовка / Изпратени / Доставени / Връщат се / Проблем / Отказани / Всички) plus a 'Забавени' chip (shipped, not delivered after N days; new ShipmentBoardSettings.delayedDays, default 7, OWNER/ADMIN form, audited). Filters: warehouse, carrier, created-date range, header warehouse scope, sidebar company/line (companyFilter). Search covers order number, shipment id, vendor ids, tracking (exact, also uppercased), customer name and phone. 50 per page, CSV export at /api/shipments/export (same filters, every page up to 20k, writeCsv formula guard, COD columns only with cod.read). Detail drawer (?id=) with vendor ids, delivery point, ticket, FulfillmentEvent timeline, a link to the order timeline and 'в ZOE ↗'.
- Header search (Ctrl/Cmd K) used to do nothing. It now queries /api/search: orders by number/customer/phone/e-mail and shipments by tracking/shipment id, same scope as the lists. Enter opens the first hit, or /shipments?q= when nothing matches. New component src/components/shell/GlobalSearch.tsx, wired into HeaderControls.tsx.
- P10-02: before this, FHB ticket_* callbacks only re-read the order and the ticket itself was dropped. processFhbCallback now stores each one idempotently (FhbTicketEvent unique per webhookEventId) into one FhbTicket per shipment: state OPEN/UPDATED/CLOSED from the latest event by time received (an older late event is counted but does not change the state), first/last event time, event count, closedAt. ticket_created raises one open task alert (kind fhb_ticket_created) per shipment and ticket_closed auto-resolves it. The order re-read stays as before.
- /tickets screen: open first, state chips with counts (Отворени / Непрегледани / Затворени / Всички), search, order + shipment links, FHB warehouse chip, company + line, event count with first/last times, age, last vendor event name (muted), 'Отвори в ZOE ↗' (plain https://zoe2.fhb.sk, already used elsewhere). 'Маркирай като прегледан' requires a note, is audited (ticket.reviewed) and resolves the ticket alert; a newer event makes the ticket unreviewed again. The screen says that euShipments has no ticket API. The Начало 'Тикети' card now counts open, unreviewed tickets and links to /tickets?tab=open.
- Tests: src/server/shipments/shipments.test.ts has 12 tests (status groups, tracking links, age, URL param parsing, counts/delayed/paging/settings, filters/search, restricted company scope in list/detail/CSV/search, CSV injection + COD permission, ticket idempotency/out-of-order/alert/close, callback route storing and re-reading, review audit/scope/permission). e2e: tests/e2e/shipments.spec.ts with seed tests/e2e/seed-shipments.ts (own group), screenshots docs/screens/p10-shipments.png and p10-tickets.png (synthetic data).

**Schema:** Migration prisma/migrations/20261103083042_shipments_tickets (additive only, BEGIN/COMMIT, RLS account_isolation policy on each table). It creates three new tables: ShipmentBoardSettings (accountId unique, delayedDays Int default 7), FhbTicket (accountId, fulfillmentId unique per account, state, lastEvent, eventCount, firstEventAt, lastEventAt, closedAt, reviewedAt/reviewedById/reviewNote; composite FK to Fulfillment, cascade) and FhbTicketEvent (ticketId, webhookEventId unique, event, receivedAt). No existing table is altered. The schema only gains back-relation lines: Account.shipmentBoardSettings, Account.fhbTickets, Fulfillment.fhbTicket. The new models are in one block at the end of prisma/schema.prisma under a wave 4 shipments banner. Already applied to the shared dev DB.

**Notes:**

P10-01 and P10-02 can be marked [x]. Decisions and open points:
(1) The shipment list is built on Fulfillment rows. Every label-kind ManualShipment (JOY_LABEL / AWB / PRE_AWB) has one; a WAREHOUSE manual order appears once Fulfill queues it (before that it is only an order in Поръчки).
(2) 'Забавени' = status SHIPPED, deliveredAt null, shippedAt (or createdAt when shippedAt is missing) older than N days. N = ShipmentBoardSettings.delayedDays, default 7, editable by OWNER/ADMIN (new permission shipments.settings), audited.
(3) The status groups (STATUS_GROUPS in src/server/shipments/board.ts) are my reading of the order statuses: ON_HOLD/BLOCKED/UNKNOWN/SUBMIT_FAILED/EXCEPTION → Проблем; COD_PAID and FULFILLED_EXTERNALLY → Доставени; RETURN_RECEIVED → Връщат се.
(4) COD column and CSV COD columns are shown only to roles with cod.read.
(5) Carrier names come from the FhbCarrier (FHB v3) and EushipmentsCourier mirrors. euShipments fulfilment orders currently store no carrier, so their carrier shows '—'. Joy parcel-service codes show raw.
(6) Tracking links come from Fulfillment.trackingUrls (FHB tracking_links, Joy). euShipments gives none, so its numbers are plain text.
(7) Link-outs: ZOE uses the plain https://zoe2.fhb.sk already in the codebase (no documented deep link). No euShipments cabinet URL exists in the code or the references, so the drawer only says the extra details are in the euShipments cabinet (no link). The owner could supply the URL.
(8) Tickets: FHB's notification body is undocumented, so there is no ticket id, text or replies — one record per shipment. A retried FHB call outside the 60-second intake dedupe window counts as a new event (event count may be slightly high). A ticket_created after ticket_closed reopens the record.
(9) New permission tickets.review = OWNER/ADMIN/OPERATOR/WAREHOUSE; ticket list view = account.read.
(10) Header search: orders by number/customer name (contains), e-mail (exact), phone (digits, 5+); shipments by tracking (exact), shipment id (contains), vendor ids (exact). The old 'search.hint' message is now unused but left in place.
(11) Phone search matches digits as stored. A phone stored with spaces only matches if the operator types it the same way.
Owner question: what is the euShipments cabinet URL to link to from Товарителници?

Commits: 530c724 P10-01/02 audit fixes: unreviewed tickets, COD once per order, account-zone days, indexes, keyset export

- MEDIUM tickets.ts unreviewed tab: now means open (OPEN/UPDATED) AND (reviewedAt null OR reviewedAt < lastEventAt), using a Prisma field reference. The chip, the list and countOpenTickets share the same where; countOpenTickets now runs a db.count instead of findMany take:5000 plus a JS filter. Regression: after a review and then a newer ticket_updated, listTickets(tab=unreviewed) gives counts.unreviewed=1 with that row; after ticket_closed it gives 0.
- MEDIUM Начало Тикети card now links to /tickets?tab=unreviewed, so the card and the list count the same thing. The e2e spec asserts the new href and the count.
- MEDIUM shipments COD: only the order's latest non-cancelled Fulfillment carries cod (codCarriers lookup in toViews). Cancelled and superseded rows show null. Regression: a rerouted order (CANCELLED original + SHIPPED new) shows COD on the live row only, and the amount appears once in the CSV cod column.
- MEDIUM date filter and CSV dates: they use Account.timezone (default Europe/Sofia) through a new dependency-free helper, src/lib/tz.ts (zonedDayStart, zonedDayEnd, zonedDay, safeTimeZone). Regression: a shipment created 2026-11-02T22:30Z is in from=to=2026-11-03, not in 2026-11-02, and its CSV created date is 2026-11-03. Switching the account to UTC moves it. Helper tests cover Sofia midnight, the DST change on 25 Oct and the fallback for an invalid zone.
- MEDIUM indexes: added the additive migration 20261103090648_shipments_search_indexes. It holds CREATE EXTENSION IF NOT EXISTS pg_trgm, Fulfillment(accountId, createdAt DESC, id DESC), Fulfillment(accountId, orderId) for the COD carrier lookup, GIN on trackingNumbers, and pg_trgm GIN on Fulfillment.externalId, Order.number and Order.customerName. The same indexes are declared in schema.prisma, so there is no drift. exportShipmentsCsv now uses keyset pagination on (createdAt, id) instead of OFFSET. Regression: 1005 shipments with the same createdAt export with no repeated or skipped rows, and a pg_indexes test confirms the indexes exist.
- LOW GlobalSearch: hits remember the text that produced them, and Enter opens the first hit only when hits.q equals the current text; otherwise it goes to /shipments?q=.
- LOW tickets paging: listTickets pages 100 per page and returns total/page/pages; the /tickets page has prev/next and a page-of line (new keys tickets.pagination/prev/next/pageOf in bg and en). Regression test with 101 tickets: all are reachable over 2 pages, and an out-of-range page is clamped.
- LOW restricted tickets test: a ticket on a Фирма А shipment and one on a Фирма Б shipment. The owner sees both; listTickets and countOpenTickets for the restricted member show only Фирма Б's.

**Schema:** New additive migration prisma/migrations/20261103090648_shipments_search_indexes (BEGIN/COMMIT, indexes only, no table or column changes). It runs CREATE EXTENSION IF NOT EXISTS pg_trgm (a trusted contrib extension that Render Postgres supports; crm_app could create it locally without superuser) and creates Fulfillment_accountId_createdAt_id_idx, Fulfillment_accountId_orderId_idx, Fulfillment_trackingNumbers_idx (GIN), Fulfillment_externalId_idx (GIN gin_trgm_ops), Order_number_idx (GIN trgm) and Order_customerName_idx (GIN trgm). Matching @@index lines were added to the Fulfillment and Order models in schema.prisma. The shared dev DB already contained Fulfillment_accountId_createdAt_idx and Order_accountId_placedAt_idx from another worktree; I left them out of this migration. The migrations test passes against seeded Order/Fulfillment rows.

**Notes:**

Wave 4 shipments track audit fixes (commit 530c724). All 5 MEDIUM and 3 LOW findings were checked, confirmed and fixed, with regression tests.

(1) 'Непрегледан' ticket now means OPEN/UPDATED and not reviewed since the latest event (reviewedAt null or reviewedAt < lastEventAt, Prisma field reference). Closed tickets are never unreviewed. The chip, the list and the Начало card use the same where, and the card links to /tickets?tab=unreviewed.

(2) COD on the Товарителници board and in its CSV goes only to the order's latest non-cancelled shipment. Cancelled originals of rerouted orders show no COD, and nothing is double-counted. Assumption: for a hypothetical multi-shipment split, the newest live shipment gets the COD. The schema has no per-shipment COD field, so if splits with separate COD ever exist, that needs a per-Fulfillment amount.

(3) The created-date filter and CSV dates use Account.timezone (default Europe/Sofia) through src/lib/tz.ts (Intl only, no new dependency). The board table still renders times with next-intl's default zone, and no app-wide timeZone is configured. Setting one in the i18n request config would align all screens; that is out of scope for this track.

(4) The new migration adds the pg_trgm extension plus board indexes, and the CSV export is now keyset-paged. pg_trgm is a contrib extension available on Render Postgres. If the owner wants no new extensions, drop the three trgm indexes and the extension, and keep the btree and GIN array ones.

(5) The ticket list is paged (100 per page, prev/next).

(6) Header search Enter no longer opens a stale hit from an earlier query.

No vendor calls and no real data. No BACKLOG/PROGRESS edits.


## P10-03/05 Офиси, PUDO, потребители + Фактури

Commits: 920168e P10-03 directory (offices, PUDO, couriers, cities, sender) + P10-05 invoices

- P10-03 Офиси, PUDO, потребители (/directory): four tabs. Офиси и PUDO pages euShipments offices/lockers and FHB pick-up points as one list on the server (counts plus one page per table, never the full list). Filters: vendor, courier/carrier, country (euShipments takes it from the courier's country mapped through EushipmentsCountry), city/postcode, type (office/locker/pudo), and search by name/code/address/officeId. Office detail shows every mirrored field and has a copy button for the order code (recipient.officeId / FHB delivery point id). Куриери: euShipments couriers with office counts and FHB carriers with pick-up point counts. Градове: euShipments cities. Потребители / подател: per euShipments connection the sender companyId, the vendor companies the token sees and the warehouses; per FHB connection the masked credential hint, mode, freshness and a 'в ZOE ↗' link. Each tab shows the last sync per connection and an 'Обнови' button (JobButton-style feedback) that queues the EXISTING jobs: eushipments.syncReference / syncCities (countries already loaded) / testConnection, and fhb.sync carriers with force (this also refreshes the pick-up lists already loaded). Everything is scoped by connection companyId through companyFilter (company + product line) and by the header warehouse scope.
- P10-05 Фактури (/invoices): an honest screen. Warehouse invoices stay in the vendor cabinets; each connection gets 'Отвори в ZOE ↗' (https://zoe2.fhb.sk, already used in the codebase), and euShipments shows the menu path 'Статистика → Списък с фактури' as text because no euShipments cabinet URL exists anywhere in the codebase or docs. Below that, a list from FhbOrderMirror.raw of the documented FHB per-order fields invoice (PDF URL, rendered as a link only when it is http(s)), invoice_number and invoice_date, with chips Всички / С PDF / Само номер with counts, search, paging and a link to the CRM order when one exists. Read-only; new permission invoices.read (OWNER/ADMIN/OPERATOR).
- Services src/server/directory/directory.ts and src/server/directory/invoices.ts, action src/app/actions/directory.ts, pages src/app/(app)/directory/page.tsx + ui.tsx and src/app/(app)/invoices/page.tsx, i18n namespaces 'directory' and 'invoices' (bg + en).
- Tests: src/server/directory/directory.test.ts (paging across both vendors, every filter, malformed URL input ignored, company scope, isolation from other accounts, couriers/cities/senders, refresh queues the right jobs, VIEWER refused, invoice JSON filters, unsafe URL dropped, WAREHOUSE refused). e2e tests/e2e/directory.spec.ts with seed tests/e2e/seed-directory.ts (own group), screenshots docs/screens/p10-*.png (synthetic data).

**Schema:** None. No migration and no change to prisma/schema.prisma. I deliberately did not add an index to EushipmentsOffice: CLAUDE.md says to ask before changing the data model of an existing table with data, and at about 40k rows the server-side count plus a top-N sort is cheap. If search turns out slow in production, a pg_trgm GIN index on EushipmentsOffice(name, code, address) is the follow-up.

**Notes:**

P10-03 and P10-05 are done (branch wave4/directory, commit 920168e). Both screens read local mirrors only and never call a vendor. Decisions and gaps:
(1) There is no euShipments cabinet URL in the codebase or docs, so /invoices and the sender tab show the euShipments menu path as text ('Статистика → Списък с фактури'; address book and client data stay in the cabinet) and no link. If the owner supplies the cabinet URL, add it as a constant.
(2) No vendor reference documents an invoice LIST endpoint (I searched docs/integrations/*). euShipments GET /get-awb/{AWB} documents INVOICED / INVOICE_NUMBER / INVOICE_DATE per AWB, but there is no client method, schema or sync for it, so I did not add it. It is a candidate for a later read job (GET only, batched over open shipments).
(3) The per-order FHB invoice fields come from FhbOrderMirror.raw (documented in the GET /order and order/history response). They are the invoice attached to the customer order, not the warehouse's own invoice; the screen says so.
(4) FHB pick-up points are still loaded per (service, country) on the FHB connection page. The directory links there, and its Обнови (fhb carriers, force) re-reads the lists already loaded.
(5) The euShipments office country comes from the courier's COUNTRY name mapped through EushipmentsCountry.isoCode for the same connection.
(6) The copy code is euShipments officeId (recipient.officeId, INTEGRATION_NOTES §4) and the FHB delivery point id (vendorId, as the FHB carriers tab already shows it). The courier code / external_code is shown underneath. Which FHB value delivery_point expects (id vs external_code) is not spelled out in the spec; worth confirming with the team.
(7) No migration or index added (see schemaChanges).
(8) New permission invoices.read: OWNER, ADMIN, OPERATOR.
(9) I could not run the CLAUDE.md auditor subagent before committing (no subagent tool in this run); run it before merging.

Commits: 3dd1d2e P10-03/P10-05 audit fixes: invoice scope by order company, PUDO dedupe, consistent invoice tabs

- MEDIUM invoice scope (verified: routing engine.ts:302-315 can ship company B's order through company A's FHB warehouse in the same line). /home/user/wt/w4-directory/src/server/directory/invoices.ts now scopes each row by the CRM order's company. A row of a CRM shipment (a Fulfillment with the same connectionId + externalId) is visible when order.companyId is in companyFilter(ctx), through any FHB connection of the account. A row the CRM did not create falls back to the connection's company. The order-link lookup is also limited to in-scope orders. Regression test: a coA warehouse carrying coA's order, coB's order and an unmatched row. The coA operator sees only coA's order and the unmatched row. The coB operator sees only coB's own row, with its order link. Also tested: search, the owner's sidebar company, and the header (euShipments-only) scope.
- MEDIUM PUDO double counting (verified). The new fhbPointBase() in /home/user/wt/w4-directory/src/server/directory/directory.ts uses only the no-country ("") list for a (connection, service) that has one, and leaves out that service's per-country lists. This applies to the offices list, totals.fhb and the couriers tab point counts. Regression test loads the same points under "" and "SK"; they count once, and a service loaded only per country still counts in full.
- MEDIUM invoice query cost: partly fixed. Each page view now runs two count queries instead of three (all and pdf; number = all - pdf because the two tabs are disjoint) and one page query. A single COUNT(*) FILTER query, as the auditor suggested, cannot be written here: raw SQL is deliberately disabled on account-scoped clients and inside withAccountTransaction (src/server/db/client.ts, tenant isolation), and I did not bypass that. The full fix (indexed columns) is left open; see notesForProgress.
- LOW 'С PDF' filter: now matches only values that start with https:// or http://. safeInvoiceUrl applies the same prefix check, so the counts and the rendered links agree. Tested with javascript:alert('http') and 'see http://...'.
- LOW numeric invoice_number: str() now accepts only strings (the reference types the field as a string), so a numeric value is neither shown nor counted. Tested with invoice_number: 77.
- Additional bug found while testing: a NOT on a JSON-path filter is SQL NULL when the key is missing, so orders with no `invoice` key at all were dropped from the 'number' tab. Fixed with an explicit Prisma.AnyNull branch; regression test checks that the number-tab count equals its row count.
- LOW delivery_point id vs external_code: the FHB list rows and the detail panel now show `id` and `external_code` with equal prominence, each with its own copy button. No text presents either one as the value to paste; the old pasteFhb copy is replaced by fhbCodesOpen (bg + en). The open question is recorded in INTEGRATION_NOTES §2.5. The e2e spec checks both values and both copy buttons.
- LOW BACKLOG/PROGRESS: not changed in code, because this task forbids editing docs/BACKLOG.md and docs/PROGRESS.md. The lines to add are in notesForProgress.

**Schema:** none (no migration)

**Notes:**

For docs/BACKLOG.md: add or mark `[x] P10-03 Справочник: offices / PUDO / couriers / cities / sender (read-only, mirrors only, Обнови queues the existing read jobs)` and `[x] P10-05 Фактури: vendor cabinets link-out (ZOE ↗, euShipments 'Статистика → Списък с фактури') + FHB per-order invoice / invoice_number / invoice_date from FhbOrderMirror.raw`.

For docs/PROGRESS.md, record these decisions:
(1) /invoices is scoped by the ORDER's company, not the warehouse's. A row of a CRM shipment is visible when its order's company is in scope, through any FHB connection. Rows the CRM did not create use the connection's company. Only cross-company shipments are loaded as (connectionId, externalId) lists, and an unrestricted member loads none. If cross-company volume ever gets large, add a nullable fulfillmentId / orderCompanyId on FhbOrderMirror.
(2) Invoice tab rules: a PDF is a JSON string starting with http(s)://; an invoice number is a non-empty JSON string. Numbers and other types are ignored, as the reference types the field as a string. A missing or null `invoice` key counts as 'no PDF'. Remaining edge case (LOW): a non-string, non-null `invoice` value (e.g. a number) drops that row from the 'number' tab only, though it still counts in 'all'; FHB documents the field as a string.
(3) Performance follow-up (the auditor's MEDIUM, partly done): two count queries + one page query per view, down from three + one, still filtering on JSON paths. The full fix is nullable invoiceUrl / invoiceNumber / invoiceDate columns on FhbOrderMirror, filled by the FHB order sync, with an additive nullable migration + backfill + index. It is not done here because CLAUDE.md says to ask before changing the data model of an existing table with data, and it touches the shared FHB sync. It needs the owner's go-ahead. A single COUNT FILTER query is not possible because raw SQL is disabled on account-scoped clients by design.
(4) FHB pick-up points: when a service has a no-country list, only that list is used; per-country lists of the same service are left out. Known limit: if the no-country list is older than a per-country list, a point that is only in the newer per-country list is hidden until the no-country list is reloaded.
(5) Open question to FHB: does order `delivery_point` take the GET /delivery-point `id` or its `external_code`? The directory shows both equally until FHB answers (INTEGRATION_NOTES §2.5).
(6) Process: the auditor subagent was not available in this run; the independent audit findings above were addressed instead.


## P10-04 Справки

Commits: 1fe3980 P10-04 Справки: six aggregate reports with period, scope and CSV

- P10-04 Справки (/reports) is built. The landing page has six cards. Each report lives at /reports/{orders,shipments,timing,cod,review,stock} and has a period bar (from/to dates in Europe/Sofia days, plus presets 7d/30d/90d/this month/last month), the sidebar company and product-line scope, the header warehouse scope, a muted note with the definitions, an inline chart and tables, and a CSV export at /api/reports/{key}/export. The CSV goes through writeCsv, so cells that start with a formula character are neutralised (CSV injection).
- 1 Поръчки: count per Sofia day, COD vs prepaid share, totals per currency (currencies are never added together, sums kept in cents), by store (manual orders shown as their own row) and by company. Cancelled orders are counted separately and left out of the totals. Chart: stacked SVG day bars.
- 2 Пратки: by warehouse and carrier, counting created, sent, delivered, returned, in transit, cancelled before shipping and submit failed. Delivery rate = delivered/sent and return rate = returned/sent; cancelled-before-shipping and submit-failed are left out of both. FHB carrier codes are named from FhbCarrier. Chart: stacked outcome bars per warehouse.
- 3 Време за обработка: steps import→approved→submitted→shipped→delivered and import→delivered. Median and p90 come from Postgres percentile_cont, overall and per warehouse of the first shipment. Times come from OrderEvent with Fulfillment dates taking priority.
- 4 Наложен платеж: uses the COD board's own rows and totalsBy (scopedRows is now exported; CodFilter has a new optional `created` range). Shows expected/received/paid/outstanding per currency and per warehouse, ageing buckets per currency, and mismatch counts with a link to /cod.
- 5 Преглед: top pre-flight finding codes from OrderCheck.findings (jsonb), Review decisions with average time spent, top reason codes with labels from listReasonCodes, and how many orders are waiting now in NEEDS_REVIEW / ON_HOLD / BLOCKED. AI agreement figures (decisionAgreed/fixesAgreed/criticalMiss/autoApprovedAt, scoped by company, shown against SPEC_MIN_AGREEMENT) appear only with ai.read and only when suggestions exist.
- 6 Наличности: a snapshot of now. Uses the stock board's rows and flags (stockBoard got an optional pageSize). Lists products that run out within runOutDays, and products with zero physical stock that still have orders not yet at a warehouse.
- Raw SQL lives in one sanctioned module, src/server/reports/sql.ts, modelled on db/vector.ts: read-only transaction, RLS set_config, an explicit accountId filter, a 20 s statement timeout, bound parameters only, and grouped results only.
- RBAC: new permission reports.read for OWNER/ADMIN/OPERATOR, and the nav item now requires it. VIEWER is excluded because cod.read and reviews.read already exclude viewers.
- Migration 20261103085231_reports_indexes adds two indexes and nothing else: Order(accountId, placedAt) and Fulfillment(accountId, createdAt).
- Tests: src/server/reports/reports.test.ts (pure range/DST/scope tests plus DB tests for all six reports, each in its own account). e2e: tests/e2e/reports.spec.ts with seed tests/e2e/seed-reports.ts (its own group and OWNER) and new screenshots docs/screens/p10-reports*.png from synthetic data.

**Schema:** Additive only. Two @@index lines on existing models: Order @@index([accountId, placedAt]) and Fulfillment @@index([accountId, createdAt]). Migration prisma/migrations/20261103085231_reports_indexes/migration.sql contains only these two CREATE INDEX statements inside BEGIN/COMMIT. No new tables or columns. It is applied to the shared dev DB. Other tracks' tables that showed up in the diff (FhbTicket, FhbTicketEvent, ShipmentBoardSettings) were left out.

**Notes:**

P10-04 Справки done (branch wave4/reports, commit 1fe3980).

Definitions shown in the UI notes:
- Orders: grouped by placedAt in Sofia days; the warehouse scope does not apply to them.
- Shipments: Fulfillments created in the period, by their current status. Delivery and return rates use "sent" as the denominator, so shipments still on the way count as sent.
- Processing time: orders placed in the period, excluding cancelled ones.
- COD: shipments created in the period, using the COD board's logic. That logic keeps its 20k-row in-memory cap and its 365-day lookback; it is reused as-is, not duplicated.
- Stock: a snapshot of now. It is scoped by line/company; the board itself has no warehouse-type filter.

No vendor call and no new dependency. Charts are inline SVG/div.

Gaps:
- euShipments shipments do not store their courier on the Fulfillment (the courierId only goes into the outbox payload), so the carrier column shows "не е записан" for them.
- Which vendor Stats/Статистика reports the team uses weekly is still an open question for the team; the landing page says the vendor reports stay in their panels.
- No background job was added.

Merge notes:
- The two index lines on Order/Fulfillment may conflict with another track adding the same index (for example shipments on Fulfillment.createdAt). Keep one copy and one migration.
- cod/board.ts: `scopedRows` is now exported and CodFilter has an optional `created` range.
- stock/board.ts: stockBoard has an optional `pageSize`.
- tools/e2e.ts: added seedReports and the E2E_REPORTS_* env vars.
- The reports nav item now has permission reports.read.

Commits: b506a53

- MEDIUM cod.ts/board.ts: when a report period (CodFilter.created) is set, scopedRows/loadRows no longer apply the COD board's 365-day lookback. loadRows now returns {rows, truncated} with ROW_CAP=20_000, and scopedRows passes truncated through. codReport returns truncated, CodView shows a warning (reports.cod.truncated, data-testid codr-truncated) and the CSV gets a 'truncated' line. The board and the sweep behave as before. Regression test: a June-August 2025 period with NOW 2026-11-02 now reports the shipment (expected 40 EUR, d30_plus ageing).
- MEDIUM orders.ts: the column is renamed 'Сума на поръчките с НП' / 'Total of COD orders' (the codTotal key is kept). There is a new codAmounts list: COD to collect, grouped by the local COD currency, with the same expected-amount logic as classifyCod (coalesce(codLocalAmount, codAmount), currency codLocalCurrency when codLocalAmount is set, else the order currency). It is never mixed with order-currency totals. It shows as its own table (data-testid orders-cod-<CUR>, with a note) and as a cod_amount CSV section. Regression test: an EUR order with HUF local COD smaller than the total.
- MEDIUM reports.test.ts: a restricted member of company A only (OPERATOR, companyScope [coA]) is now tested against the database for shipments (the euShipments/coB warehouse is missing), timing (coB's order is missing), COD (no HUF totals, no euShipments warehouse), review (coB's finding, CANCEL decision and BLOCKED order are not counted; the coB-only operator sees only coB) and stock (only coA's open units). lineCompanyIds=[] is also tested for shipments, timing and COD.
- LOW review.ts: 'Waiting now' uses only the company scope, not placedAt. The note says so (bg/en). Test: an ON_HOLD order placed long before the period is counted.
- LOW shipments.ts: a new cancelledAfterShip bucket (CANCELLED and sent and not delivered). inTransit = sent - delivered - returned - cancelledAfterShip. It appears as a new column in the UI and the CSV (cancelled_after_shipping), and the note is updated. The test covers a cancelled-after-ship FHB shipment.
- LOW review.ts: the min(message_bg) sample is gone from the query, the UI and the CSV, so findings show only code, severity and count. Test: the CSV does not contain the message text.
- Checks: prettier, typecheck, lint, the full unit suite (73 files / 1133 tests) and the e2e spec tests/e2e/reports.spec.ts on port 3113 all exit 0. Committed b506a53 on wave4/reports.

**Schema:** none (no Prisma schema change, no migration)

**Notes:**

P10-04 audit fixes (wave4/reports, b506a53). All six findings were verified as correct and fixed, each with a regression test.
(1) COD report: a report period now bypasses the COD board's 365-day lookback. src/server/cod/board.ts loadRows takes a lookback flag and returns {rows, truncated}, with ROW_CAP=20_000 exported. scopedRows sets lookback=false when f.created is set, and the board, CSV and sweep keep the lookback. A truncated flag is shown on the COD report screen and in its CSV.
(2) Orders report: the 'От тях НП' column is renamed 'Сума на поръчките с НП' because it sums order totals. A new table, 'Наложен платеж за събиране (местна валута)', shows COD amounts in the local COD currency, computed the same way as the 'Очаквано' expected amount in the COD report (classifyCod).
(3) Every report now has a DB test for a restricted company-A member.
(4) Review 'Сега чакат' is the current backlog regardless of placement date.
(5) Shipments: cancelled after shipping is a separate column and no longer counts as in transit.
(6) The review findings aggregate and its CSV carry only code, severity and count; finding messages can quote recipient data and are left out.
New i18n keys under reports.*: orders.codAmounts, orders.codAmountsNote, orders.col.codAmount, cod.truncated, shipments.col.cancelledAfterShip. The texts of orders.col.codTotal, shipments.note and review.note changed.

