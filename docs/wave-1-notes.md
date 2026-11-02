# Wave 1 — builder notes (decisions, spec findings, open questions)

Verbatim hand-off notes of each wave-1 agent, in order. Synthetic data only.

## build:fhb:1
BLOCKED: []
BUILT
- src/integrations/fhb-v3: schemas.ts, client.ts, status-map.ts, validators.ts, phone.ts, mapper.ts, adapter.ts, __fixtures__/openapi-examples.json (56 examples taken from the raw OpenAPI spec, vendor doc data only).
- src/server/fhb: connection.ts, callback-token.ts, apply.ts, transport.ts, orders.ts, products.ts, inbound.ts, callbacks.ts, jobs.ts.
- Route: src/app/api/webhooks/fhb/[...path]/route.ts.

FINDINGS FROM THE SPEC (record in INTEGRATION_NOTES)
1. FHB response bodies are NOT wrapped. The "response" key in the rendered fhb-kika-v3.md is only the example's name.
2. The spec's own POST /order example sends country "sk" in lower case. Request schemas accept either case; we send upper case.
3. PUT /order's body list has no id, validate or invoice_number, so the update schema omits them.
4. PUT /product requires name.
5. POST /order documents only 200/401: no 400 and no duplicate-id answer. GET /order documents no 404. Our rule: GET /order 404 means "not found"; any other failure during read-back means UNCERTAIN plus an operator task.
6. One delivery-point 400 example has violations as plain strings instead of {code, message}. The schema accepts both.

DECISIONS
- Status map. CrmOrderStatus has neither RETURNED nor REJECTED:
  - returned, or returned_at set → RETURN_RECEIVED. This matches SPEC 6.5, where FHB RMA means back at the warehouse.
  - rejected → BLOCKED plus a CRITICAL task.
  - unknown → UNKNOWN plus one alert per shipment (deduped).
  - INTEGRATION_NOTES §2.4 still says RETURNED/REJECTED; please update it.
- Order notification URL shape is `/api/webhooks/fhb/{connectionId}/order/{fulfillmentId}/{event}/{token}`. This differs from the notes' `/webhooks/fhb/{connectionId}/order/{event}/{token}`:
  - FHB documents no order-callback body, so the shipment id must be in the URL for the worker to know what to re-read (GET /order?id=externalId).
  - GET and POST are both accepted.
  - Stock URL: `/api/webhooks/fhb/{connectionId}/stock/{token}`. The body is used only as a pointer to the product id; numbers come from GET /product.
- Callback tokens:
  - Each token is an HMAC-SHA256 over (connection, purpose), using a key derived from CREDENTIALS_KEY via HKDF (label "fhb-callback-v1"). Length 32, base64url.
  - Rotating CREDENTIALS_KEY invalidates every URL already stored at FHB (on orders and products); they would have to be re-sent.
  - A forged token gets a 404 without touching the DB.
  - Intake stores a pointer only. Duplicates are deduped by sha256(path|body|60-second bucket).
  - The "fhb.callback" queue re-reads; the "fhb.callbackSweep" queue re-queues RECEIVED/FAILED events older than 2 min, up to 10 attempts.
- Outbox operations: fhb.product.create/update, fhb.order.create/update/delete, fhb.stockReceipt.create/update/delete.
  - Payload envelope: {id, body, meta?}. meta is CRM-only (e.g. productId) and is never sent.
  - Idempotency keys:
    - creates: fhb.order.create:{externalId}, fhb.product.create:{vendorId}, fhb.stockReceipt.create:{externalRef}.
    - updates: the same prefix plus {id}:{payloadHash}, so the same change twice is one request.
    - deletes: fhb.order.delete:{externalId}, fhb.stockReceipt.delete:{externalRef}.
  - supportsTestMode is false: FHB has no test flag, so DRY_RUN only records the payload.
- Read-back after a timeout or 5xx:
  - creates: GET by the deterministic id.
  - updates: GET and compare what we sent. A PUT of the same body is idempotent, so "not applied" may be re-sent.
  - deletes: "gone" counts as done.
- A write that never left is a definite refusal (FAILED, can be re-submitted), not UNCERTAIN: missing or unreadable credentials, login failure, or 429 after all retries.
- Client behaviour:
  - Token cached until expiration minus 5 min (at least 60 s), in memory per process.
  - One re-login on a 401.
  - At most 4 concurrent requests per credential set.
  - Backoff with jitter on 429 for all methods, and on 5xx or network errors for GETs only.
  - Writes are never retried inside the client.
  - Timeout 30 s.
- Order external id = {STORECODE}-{order number without "#"}. A reship after a cancelled shipment gets -2, -3, … because FHB does not document whether a deleted id can be reused.
- Variable symbol comes from FulfillmentConnection.variableSymbolNext, taken under a connection row lock in the same transaction as validation, the Fulfillment row and the outbox row. A hard block rolls everything back, so no symbol is consumed. Maximum is 9999999999.
- Re-submitting after SUBMIT_FAILED or DRY_RUN re-arms the same request, with the same id and symbol.
- COD and declared value:
  - Sent only in the destination's local currency, taken from the CountrySetting table.
  - If the order currency differs, the stored codLocalAmount/codLocalCurrency is used. Otherwise it is a hard block.
  - Value uses codRate when available; if it can't be converted it is left out, with a soft warning.
  - No rate table exists yet. Per-country rounding beyond 2 decimals is not implemented because nothing in the docs defines it.
- Phones: E.164 using public ITU calling codes and trunk prefixes (HU uses 06). This is separate from the euShipments §4.4 rules.
- Soft pre-flight findings require acknowledgeWarnings=true (errors fhb_preflight_failed / fhb_preflight_needs_ack, with findings attached).
- Products:
  - EAN: the oldest ProductEan is sent on create only. Updates never carry an EAN unless explicitEan, a value a person typed, is given. FHB's EAN is mirrored read-only in VendorProduct.vendorEan.
  - Multi-products: components must be mirrored, active and single at FHB. Demoting multi to single is blocked. Bundle components are passed in by the caller because there is no schema field for them yet.
- Stock receipts: externalRef is IN-YYYYMMDD-{10 hex}, generated once and stored. Update/delete are allowed only while the raw status is "created".
- Order.status (the CRM pipeline) is NOT changed by FHB events. Only Fulfillment status, raw status, tracking and events move; P4-03 should take this over.
- New permissions: vendorProducts.write (OWNER, ADMIN) and orders.cancelAtWarehouse (OWNER, ADMIN, OPERATOR). Submitting uses orders.fulfill; inbound uses inbound.manage.
- Company scope:
  - Orders are checked against order.companyId; the warehouse connection may belong to another company, as SPEC allows.
  - Products and inbound are checked against connection.companyId.
- No UI in this part. createFhbConnection / rotateFhbCredentials exist as services (credentials sealed as JSON {appId, secret}; new connections start READ_ONLY) for P2-08.

LEFT FOR PART 2 / LATER
- P2-02 read side and the history sweep. GET helpers for product, products, order, history, parcel-service, delivery-point and stock-receipt already exist on the client.
- pnpm check:live entry for FHB.
- Alert when a CANARY order leaves "pending" unexpectedly (INTEGRATION_NOTES §6).
- Storing tracking_events as FulfillmentEvents.
- PUT /order/invoice and POST /order/files are not implemented.

## build:eushipments:1
BLOCKED: [{"id": "P3-05 (barcode read-back)", "reason": "INTEGRATION_NOTES §4.2 says to read back via get-products after creation and check which barcode was actually stored, but get-products (Product_List_Web_Service-v1.0) returns only ID, NAME, DESCRIPTION, LENGTH_ITEM, WIDTH, HEIGHT, WEIGHT and REFERENCE_NUMBER. It has no barcode field. Question for euShipments: which endpoint returns the stored barcode of a product, so we can detect the rare 'created without a barcode' race? Until there is one, the barcode we sent is kept in VendorProduct.raw.barcodeSent and vendorEan stays null."}, {"id": "P3-05 (create-order testMode answer)", "reason": "The spec does not describe what create-order returns when testMode is true. The current code reads a 2xx without an error text as a pass and an error text as the validation result. This needs confirming with euShipments at GATE P3-G1, together with the existing question of whether testMode on production leaves anything visible to the warehouse."}, {"id": "P3-03 (vendor date time zone)", "reason": "The spec does not say which time zone the orders-history DATE values ('YYYY-MM-DD HH:mm:ss', no zone) are in. They are read as Europe/Sofia local time for the 'stuck in Information received' threshold and event times. Please confirm with euShipments."}]
ENVIRONMENT: the local Postgres cluster had been reset (no crm or crm_app roles, no crm_dev). Recreated roles crm (superuser) and crm_app with the passwords from .env, pgvector in template1, crm_dev, and a private crm_dev_eushipments.

P3-01: src/integrations/eushipments/{config,errors,schemas,client}.ts.
- Every write takes testMode as an explicit argument and always sends it. Stored outbox bodies never contain testMode; the transport adds it at send time.
- Writes are never retried inside the client. A 4xx is a definite rejection. Timeout, network error, 429, 5xx or an unreadable 2xx throws EuShipmentsError("unknown_outcome"), so the outbox reads back.
- A transfer 409 DUPLICATE_EXTERNAL_REF is treated as success (it returns the existing protocol).
- Reads retry on 429/5xx and Zod-parse the answer.
- classifyHistoryItem: only errorCode 404 + "Not found order" means not created. Any other per-item error inside HTTP 200 is an error.

P3-03: status-map.ts holds the normalised-text matcher (Cyrillic/Greek look-alikes, every dash variant, NBSP and spaces, lowercase) and the spec's full list with final flags. The 'any Warehouse/Loaded hub/Unloaded hub …' family rule maps to IN_TRANSIT without an alert.
- CRM mapping: IN_TRANSIT goes to SHIPPED, because CrmOrderStatus has no in-transit value.
- Cancel(38) is CANCEL_PENDING: the shipment keeps its previous CRM status and polling continues, because CrmOrderStatus has no CANCEL_PENDING. Adding the enum value is a decision for later.
- COD paid goes to DELIVERED, as INTEGRATION_NOTES says, not to COD_PAID.
- src/server/eushipments/statuses.ts seeds the table per group (lazily, on first use) and provides applyOrderHistory(accountId, fulfillmentId, item):
  - stores each record once, as FulfillmentEvent source 'eushipments', deduplicated by payload.recordId;
  - sets status from the latest record, plus AWB, return AWB and shipped/delivered times;
  - records unseen texts as observed rows with confirmed=false, which stay UNKNOWN until an operator maps them with setStatusMapping;
  - alerts only when a NEW record is the current status: blocked (CRITICAL task), return_received (task to notify support), exception, unknown_status, delivery_attempt_failed;
  - raises eushipments_stuck_accepted once the ACCEPTED-group run exceeds EushipmentsSettings.acceptedAlertHours (default 24 h, working days Mon–Fri counted in UTC);
  - never opens a duplicate alert while the same kind is still open.
- The 15-min poller and batching (P3-02) should call applyOrderHistory and stop when stopPolling is true.

P3-04: phone.ts.
- BG and RO send the national form with trunk 0 (the spec's BG example is 0889000000). GR sends 10 digits and PL 9 digits.
- CZ, HU, SK and HR send +code + 9 digits. Trunk prefixes are stripped, including a doubled prefix such as +36 06….
- HR accepts exactly 9 digits, as the spec says. 8-digit Croatian mobiles would be blocked; review if real data shows them.

P3-04: mapper.ts and validators.ts.
- address1 goes whole into streetName (no house-number splitting). address2 and company go to addressText.
- distributeCod scales line totals to the local COD and puts the rounding on a line whose quantity divides it. If no line can take it, the order is blocked with cod_price_split for cash-receipt senders; other senders just send no prices.
- validateEuOrder returns INTEGRATION_NOTES §5-shaped findings: phone, zod limits with exact field paths, waybill date (Sofia today … +9), Σ(price×qty)=COD for EushipmentsSettings.cashReceiptCod, building-number (8) and addressText (100) truncation warnings, and street without a number.

P3-05: adapter.ts holds EuShipmentsTransport. Operations are eushipments.{createOrder, createProduct, deleteOrder, attachPdf, createRequest, createTransfer}. The outbox payload is {body, ctx}; ctx carries our ids and is never sent to the vendor. supportsTestMode is true only for createOrder and createTransfer; every other operation is only recorded in DRY_RUN. Read-back per operation:
- create-order: orders-history by reference.
- create-product: get-products by refNumber.
- delete: orders-history shows Deleted/Cancelled.
- transfer: resend with the same externalRef.
- attach-pdf and booking: no read-back, so the outbox marks them UNCERTAIN with a task and never retries; the inbound is set to UNCERTAIN.
Domain effects (src/server/eushipments/effects.ts) run only for real sends and are idempotent:
- create-order accepted: Fulfillment ACCEPTED with vendorOrderId, Order ACCEPTED, attach-pdf queued with key attach-pdf:<ref>.
- create-order rejected: SUBMIT_FAILED plus an eushipments_submit_failed task.
- product created: VendorProduct created or updated, with vendorEan never written.
- barcode collision: eushipments_barcode_collision task, resolved automatically on the next successful create.
- booking created: requestId stored on the InboundShipment.
- transfer created: protocolId stored.
Services (src/server/eushipments/write.ts) check RBAC and company scope:
- queueEuProduct (connections.manage; optional barcode override).
- queueEuOrder (orders.fulfill). Returns blocked, needs_ack (warning codes must be passed in `acknowledged`) or queued. Reference is {STORECODE}-{number} (M-{number} for manual orders), kept unique by Fulfillment (connectionId, externalId). Only a SUBMIT_FAILED fulfillment can be re-queued under the same reference.
- queueEuOrderDeletion (orders.fulfill).
- queueEuBooking (inbound.manage). documentNumber is both the externalRef and the clientReference.
- queueEuTransfer (stock.manage). externalRef is CRM-TRF-<transferId>.
- The token is the whole vault secret. senderId/companyId comes from FulfillmentConnection.vendorIds.companyId.

Wiring: src/worker/main.ts now uses resolveTransport: (c) => resolveEuShipmentsTransport(c). The FHB track will need to combine its resolver on that same line; expect a one-line merge conflict.

Not done here (P3-02 read side): pollers, stock-availability pre-flight with snapshot age, get-prod-avails, and mirror tables. i18n: no UI was built, so messages/*.json and rbac.ts are untouched. Validator findings carry message_bg and message_en inline, as INTEGRATION_NOTES §5 specifies.

## build:api-watcher:1
BLOCKED: []
P9-01 and P9-02 are done in src/server/api-watcher/. Points to record:

- Sources: src/server/api-watcher/sources.ts uses the same 3 URLs as tools/fetch_specs.sh, and the vendor keys equal the ConnectionType names (FHB_V3, FHB_JOY, EUSHIPMENTS).
- normalise.ts:
  - The hash covers the whole document with keys sorted. For Postman, the volatile keys _postman_id, id, publishDate, publishedId, collectionId, owner and similar are dropped first.
  - OpenAPI is reduced to endpoints (METHOD path) with params, body fields and response fields; $ref is resolved and recursion is guarded. The changelog is taken from the 'Change log' heading in info.description.
  - Postman requests are keyed as METHOD path [name without version]; numeric and {var} path segments fold to {}. Fields come from the annotated body JSON and from the description HTML tables: field/parameter+type+required tables, Field/Description output tables, Code tables, ID/Status and Meaning status tables, and Version/Change changelog tables. Each endpoint also gets a prose hash, because euShipments puts rules in text.
- diff.ts classifies each change from our side of the integration:
  - Breaking: endpoint removed or deprecated, request field newly required or removed, response field removed or now optional, type change, request enum value removed, NEW response enum value (it hits the status map), request constraint change.
  - Additive: new endpoint, new optional input, new output, new request enum value.
  - Info: wording, title, changelog lines.
- brief.ts writes the markdown upgrade brief: counts, Breaking / Additive / Info sections, affected adapter files (client, adapter, mapper, validators, schemas, status-map, fixtures, tests) and steps (pnpm docs:refresh, update notes and PROGRESS, keep DRY_RUN until an OWNER raises).
- watcher.ts:
  - The first fetch stores a baseline with no alert; the same hash is a no-op.
  - A new hash stores a new ApiSpecVersion with diff = {counts, changes, previousId, brief} and raises one deduped alert per account (CRITICAL if anything is breaking, WARNING if additive, else INFO).
  - On a breaking change, every CANARY/LIVE connection of that vendor in every account drops to DRY_RUN (SPEC §8), audited as connection.mode_change with userId null. Requests in AWAITING_CONFIRMATION go back to PENDING, as setConnectionMode does.
  - Fetch failures are counted in ApiWatchSource and alerted once after 3 in a row. A bad envelope (Zod) counts as a failure, not a change.
- Shopify version watch (shopify-version.ts):
  - Calendar rule: a version is supported until its release month + 12 months; WARNING at 90 days left, CRITICAL at 30.
  - It also uses the publicApiVersions list reported by the live check, stored as ApiSpecVersion vendor SHOPIFY. Pinned version unsupported is CRITICAL; pinned being the oldest supported version is a WARNING. The publicApiVersions field (handle, displayName, supported) was verified in the Shopify Admin 2026-10 docs.
- Live check (live-check.ts):
  - Adapters plug into a `LiveCheck` registry: registerLiveCheck({type, run(target, ctx)}). Helpers for adapters: validateProbe (Zod failures become breaking issues with paths and no values; unknown keys become new_field warnings), unknownKeys, and checkEnum (unknown enum is a non-breaking warning).
  - Targets: stores with credentials and connectionStatus.ok, and enabled connections with credentials.
  - Breaking issue: the store's writeBackMode and inventoryPushMode go LIVE to DRY_RUN; a connection goes CANARY/LIVE to DRY_RUN. Modes are never raised. Audited as store.mode.autoLower or connection.mode_change, plus a CRITICAL alert.
  - Non-breaking issues give a WARNING alert. If the probe cannot run (auth or network), a WARNING alert is raised and modes are left alone.
  - Shopify implementation: shopify-live-check.ts runs Shop, OrdersPage first:1, VariantsPage first:1 and ApiVersions (queries only). A GraphQL 'field does not exist' error counts as breaking.
  - FHB v3, Joy and euShipments adapters should call registerLiveCheck in their own module and have registerApiWatcherWorkers call it, or register at worker start.
- Queues:
  - apiwatch.specs: daily cron 23 2 * * *, stately, runs the spec watch and the Shopify version watch.
  - apiwatch.liveCheck: daily cron 47 3 * * *, stately, fans out one job per target.
  - apiwatch.liveCheckTarget: stately, singletonKey kind:id, payload {accountId, kind, id}.
- Alert kinds are prefixed api.*. Alert titles are English, like the existing alerts; the UI labels are i18n.
- UI: /settings/api-changes (permission apiWatch.read = OWNER, ADMIN), linked from Settings → System jobs. I added no sidebar nav item, to stay within my own i18n namespace; the nav key needs a 'nav.apiChanges' entry if wanted. The page shows open alerts with briefs and a Resolve button (audited alert.resolve), the sources table and the version history with an expandable brief.
- The upgrade brief tells the human to run pnpm docs:refresh locally. The deployed worker does not regenerate docs/integrations/*.md, since there is no repo or python there.
- tools/check-live.ts (pnpm check:live) is still the phase-0 stub; it could later loop over the LiveCheck registry.
- I did not merge origin/main: the branch is 2 commits behind (Shopify live fixes), per the no-rebase rule.
- Deliberate policy choice, flagged for review: a breaking spec diff demotes ALL CANARY/LIVE connections of that vendor across accounts, following SPEC §8 literally. False positives (for example a tightened constraint) only ever lower modes.

## build:fhb:2
BLOCKED: []
P2-02 read side (src/server/fhb/sync.ts, src/integrations/fhb-v3/read-mapper.ts; new client methods and schemas in client.ts and schemas.ts):
- Only GET calls, so sync runs in every liveMode, READ_ONLY included.
- Products are read 250 per page into VendorProduct and StockLevel (physical = stock_quantity, free = free_quantity, sellable = min(free, physical − reserved)).
- Auto-link to the master Product is by exact SKU after removing the connection prefix (crmSkuFromFhbId). EAN is never used, and a test proves it. Unlinked FHB products appear under "Несвързани" on the stock board and are linked by hand by SKU.
- stock/all updates only the physical quantity of products already mirrored.
- stock/movements go into the existing StockMovement table (externalId = FHB movement id, kind = raw in/out, quantity = signed change). The next run starts from the newest date seen minus 1 hour.
- order/history (created in the last 30 days, 90 on the first run) and rma/list (from the last good run minus 3 days, return date) go into FhbOrderMirror. RMA rows get inRma = true.
- CRM shipments (Fulfillment) are updated through applyFhbOrderView, but only when the raw status, tracking or return info changed.
- return/list goes into FhbReturnMirror.
- cod/list (120-day window on creation date) goes into FhbCodMirror and also sets Fulfillment.codStatus to the raw value.
- parcel-service goes into FhbCarrier and is refreshed at most once a day; carriers no longer offered are removed.
- delivery-point is loaded per (service, country) on request into FhbPickupPoint. Each load replaces exactly that list, and loaded lists are refreshed with the carriers.
- Unknown order or COD statuses are stored raw, the order status maps to UNKNOWN, and one alert is raised per raw value (entityType FhbStatus), never thrown.
- FhbSyncState keeps lastRunAt, lastOkAt, lastError (scrubbed), lastCount and cursor per resource; the screens show this as freshness.
- Two new queues: fhb.sync (stately, singletonKey connection:resource:service:country:externalId, 3 retries) and fhb.reconcile (cron every 30 min, queues every periodic resource of every enabled FHB connection that has credentials).
- Creating a connection queues a full first read.
- There is a single-order re-read (resource "order", GET /order?id=) behind a button on the order detail. It is wired into the job but has no dedicated unit test.

Parameter formats taken from the raw OpenAPI spec:
- order/history and stock/movements: from/to as ISO timestamps (spec example 2019-01-01T00:00:00.000Z).
- cod/list, rma/list, return/list: ISO dates (YYYY-MM-DD).
- stock/all has no paging documented, so it is read in one call.
- Paging stops on an empty page, a short page or when `total` is reached, capped at 2000 pages.
- Responses are not wrapped in a "response" key (that key is only the example's name in the spec).
- To confirm with the real responses at P2-09: whether paging is 1-based everywhere, and how big stock/all is.

P2-03 fixture recording:
- `pnpm fixtures:record -- --connection <id> [--pickup service:country] [--limit 5]` (tools/fixtures-record.ts plus src/integrations/fhb-v3/fixture-recorder.ts). It refuses to run when CI is set.
- It makes GET calls only, reads raw bodies with z.unknown(), records whether each one matches our schema (issue paths only, no values), cuts lists to --limit items and scrubs every body before writing to src/integrations/fhb-v3/__fixtures__/recorded/<name>.json.
- The scrubber (fixture-scrubber.ts) keeps the shape of each value but replaces it:
  - strings become SYN-n, emails syn<n>@example.test, URLs https://example.test/syn/<n>, and phone fields +999000nnnnnn;
  - dates keep their format but move to the year 2001;
  - numbers other than 0 become ±(900000+n), with .25 added when the original was not a whole number;
  - `page`, booleans and null are kept;
  - code-like values under status, type, return_type, action, parcel_service, code, event_code, carrier_event_code, country and currency are kept.
- The same original value always gets the same replacement within one run, so ids still match across files.
- findUnscrubbed() makes fixture-scrubber.test.ts fail on any value the scrubber could not have produced. The recorded/ folder is empty until GATE P2-G1 (it holds only a README).
- New vendor-doc example file: __fixtures__/read-examples.json, extracted unchanged from the raw OpenAPI for stock/all, stock, stock/movements, cod, cod/list, rma/list, return/list and return/{uid}.

P2-08 screens:
- /warehouses gets an added FhbConnectionsSection: cards showing mode, counts, freshness, failing syncs and an "Отвори ZOE ↗" link, plus the add form (OWNER/ADMIN; credentials go to the vault and are never rendered back; the connection starts READ_ONLY).
- /warehouses/fhb/[id] has these tabs, each with ZOE's original name underneath: Продукти и наличности (Stock), Поръчки (Orders), Върнати от куриер (RMA), Връщания в склада (Return), Наложен платеж (COD), Приемане на стока (Stock receipts), Куриери и PUDO (Parcel services), Заявки към склада (API requests), Настройки (API, Settings).
- The requests tab is the DRY_RUN payload preview. It shows the exact vendor body only to OWNER/ADMIN (new permission outbox.payloads) and never the CRM-only meta.
- Mode changes go through setConnectionMode (only an OWNER raises, both raises and lowers are audited), with an added company-scope check.
- /products/stock is the ZOE-Stock board, linked from the /products header. It has tabs (Наличности, Движения, Комплекти, Архив), search by name, SKU, RTM/RSK codes or EAN (EAN is a search term only), quick filters with counts (Всички, С наличност, Нулева, Тестери, Несвързани), "реален, от FHB" when FHB's EAN differs from ours, a side panel, 50 rows per page, and a "Партиди и срокове в ZOE ↗" link.
- New permissions: connections.sync (OWNER, ADMIN, OPERATOR) and outbox.payloads (OWNER, ADMIN).
- i18n: only the `fhb` namespace was extended, in bg and en.
- e2e: tests/e2e/fhb.spec.ts with the synthetic seed in tests/e2e/seed-fhb.ts, added to tools/e2e.ts with one line.

Gaps to list in PROGRESS:
- docs/reference-screens/fhb/ is local-only and missing here, so the screenshot coverage check for P2-08 could not be done.
- Not built from DESIGN screen 4:
  - "Свършват до 7 дни" (needs sales velocity);
  - "Разминаване със Shopify" (needs Shopify inventory quantities);
  - the Известия tab;
  - the "Тестерите под оригинала" grouping (sorted by FHB id instead);
  - the euShipments and Shopify columns, which belong to other tracks.
- Return photos (GET /return/{uid}/photo/{id}) and GET /stock/history/{date} are not mirrored. The photo count is shown.

Process notes:
- CLAUDE.md asks for the auditor subagent before every commit, but no subagent tool was available in this run, so no audit was done. Run one before merging.
- tools/check-live.ts is still the empty placeholder; the FHB read-only live check was not part of these items.

Merge notes:
- Other tracks will conflict in tools/e2e.ts (one inserted line), warehouses/page.tsx (one import plus one component line), products/page.tsx (header action), rbac.ts and its test (two entries appended), queues.ts (two entries appended at the end), and package.json (one script line).

## fix:api-watcher
BLOCKED: []
I checked every auditor finding against the code. All of them were valid and all are fixed on branch wave1/api-watcher.

HIGH-1, crash safety of spec changes (watcher.ts). A changed ApiSpecVersion is now stored with diff.applied=false. After that come demoteVendorConnections, then raiseAlertEverywhere, then applied=true is set. Every watchSource run starts with finishUnapplied(source), before the fetch and the hash compare. Both side-effect steps are idempotent. Regression test in watcher.test.ts (vi.mock wraps the real safety functions). Demotion is made to throw once: the outcome is failed/internal, the row stays applied=false and the connection stays LIVE. Alerting is then made to throw once: the connection is demoted. The third run returns 'unchanged', and the result is applied=true, the connection DRY_RUN, and exactly one CRITICAL alert per account.

HIGH-2, alert escalation (safety.ts raiseAlert). If an open alert with the same kind and entity has a lower severity, it is updated in place: severity, title, body, and status set back to OPEN. An equal or lower severity is still skipped. Tests:
- Shopify version: the WARNING raised at 60 days becomes CRITICAL at 16 days, and a later WARNING does not lower it.
- Live check: an open new-field WARNING becomes the CRITICAL 'dropped to DRY_RUN' alert.

MEDIUM-3, Shopify schema errors. ShopifyError now has a graphqlCodes field, filled by the client from errors[].extensions.code. The shopify-live-check probe counts a breaking query_rejected only for these codes: undefinedField, argumentNotAccepted, undefinedType, missingRequiredArguments. Only when Shopify sends no code at all does it fall back to the message ("doesn't exist on type", "doesn't accept argument", "No such type"). Every other GraphQL error is rethrown, so the check counts as 'could not run': a WARNING live_check_failed alert and no mode change. Test: ACCESS_DENIED, INTERNAL_SERVER_ERROR and MAX_COST_EXCEEDED all leave writeBackMode LIVE.
- Caveat: the code list is the standard graphql-ruby static-validation set. It is not taken from a vendor document in docs/integrations, because there is no Shopify error reference there. If we ever add Shopify's error reference to the docs, check the list against it.

MEDIUM-4, committed baseline. When no ApiSpecVersion exists, readCommittedSpec loads source.rawFile from process.cwd() and checks it with the same envelope Zod schema. It is stored as the baseline, with sourceUrl 'repo:<rawFile>' and fetchedAt 1 second earlier than the live fetch. The live fetch is then diffed against it, with the usual alerts and demotion. If the raw copy is missing or unreadable, the first live fetch is the baseline, as before. Tests cover both cases, plus one that loads all three committed raw specs.
- Assumption: Render runs the service from the repo root, so docs/integrations/raw/* is present at runtime. If the build ever drops docs/, the code falls back to the old behaviour and logs a warning.

LOW findings, all fixed:
- resolveApiAlert now does a direct findFirst (id, kind startsWith 'api.', not RESOLVED) plus a company-scope check for Store and FulfillmentConnection entities. resolveApiAlertAction catches DomainError. Test: an alert older than 55 newer ones can be resolved, and the company scope is enforced.
- New permission apiWatch.manage (OWNER, ADMIN), added to the rbac matrix test. resolveApiAlert uses assertCan and the action uses requireAccountContext('apiWatch.manage'); neither returns silently any more. The Resolve button is shown only with apiWatch.manage.
- The apiwatch.liveCheckTarget job re-reads only its own target: liveCheckTargets({accountId, kind, id}) with the same filters. Test added.
- BACKLOG.md and PROGRESS.md: I did not edit them, as the hard rules say. At merge, mark P9-01 and P9-02 [x] in BACKLOG.md and add these notes to PROGRESS.md. Also record this decision: SPEC §8 says to regenerate docs/integrations/*.md with tools/render_docs.py, but this is not automated. The watcher stores the diff and an upgrade brief, and a developer regenerates the reference by hand with pnpm docs:refresh.

Extra bug found and fixed. The i18n keys apiWatch.kinds.* contained '.' (for example 'api.spec_change'). next-intl rejects that with INVALID_KEY, so the alert kind labels never rendered. They were renamed without the dot (spec_change and so on), and the page strips the 'api.' prefix before the lookup. The e2e spec now asserts the Bulgarian kind label 'Промяна в спецификацията'.

## build:eushipments:2
BLOCKED: [{"id": "P3-06 screenshot coverage check", "reason": "docs/reference-screens/eushipments/ does not exist in the repo, so the coverage check against vendor-panel screenshots could not be done. Question for the owner: please put the euShipments cabinet screenshots in docs/reference-screens/eushipments/ (they stay local and git-ignored) so the fields and actions can be checked against the mirror tabs."}, {"id": "P3-02 barcode read-back", "reason": "INTEGRATION_NOTES §4.2 says to read back via get-products after create-product and check which barcode was stored. The Product_List reference has no barcode field. So the stored barcode cannot be verified, and VendorProduct.vendorEan stays null for euShipments. Question for euShipments: which endpoint returns a product's stored barcode?"}, {"id": "P3-02 get-prod-avails attribution", "reason": "get-prod-avails takes no parameters and names a row's company only by CUST_NAME, not by ID. With one token seeing several companies, rows are given to a connection only when CUST_NAME equals that company's NAME from get-user-companies; rows that cannot be matched are counted as 'unattributed' and skipped. Question for euShipments: is CUST_NAME always identical to the get-user-companies NAME, or is there a company id per row?"}]
Wave 1 / euShipments part 2 (P3-02, fixtures, P3-06).

**Decisions:**
- Read side: src/server/eushipments/read.ts, with Zod schemas added to src/integrations/eushipments/schemas.ts.
  - It only uses GET/list calls plus the read-only POSTs fulfilment/warehouses, orders-history and booking-request-status. These are allowed in every mode, including READ_ONLY.
  - The documented "no data" answers are treated as empty results, not errors: get-countries 404, offices-by-courier 404, and check-cod-by-order returning HTTP 200 with a null body.
- Products go into VendorProduct with vendorId = REFERENCE_NUMBER (the join key in orders and bookings) and vendorCode = euShipments ID.
  - A new row is auto-matched to exactly one master Product by SKU, with the connection's skuPrefixRule.prefix stripped (case-insensitive). An existing link, automatic or manual, is never changed. EAN is never used.
  - Products missing from get-products are archived after a 1 h grace period and come back if they reappear.
- Stock: get-prod-avails rows are stored per warehouse in EushipmentsStock and summed into StockLevel (source POLL, snapshotAt = AVAIL_DATE read as Europe/Sofia time).
  - The vendor gives one "available" number, stored as both physical and free; CRM reservations are kept as they are.
  - A linked product missing from a snapshot is set to 0.
- Shipment polling: orders-history in batches of 100 for fulfillments in ACCEPTED, PROCESSING, SHIPPED, RETURNING, EXCEPTION, BLOCKED or UNKNOWN, using part 1's applyOrderHistory.
  - EushipmentsTracking.stopPolling is set when a final status is reached; returns keep polling until received.
  - A documented 404 "not found" for a shipment we recorded as created opens a CRITICAL task (kind eushipments_not_found).
  - One failing batch does not stop the others; if every batch fails, the job fails and retries.
- Bookings: booking-request-status lifecycle maps to InboundShipment.status CREATED / RECEIVED / CLOSED / DELETED.
  - On CLOSED, InboundLine.receivedQty and the warehouse comment are filled in.
  - A difference, a warehouse comment, or a product we did not book opens one task (kind eushipments_inbound_discrepancy).
- COD: check-cod-by-order runs for DELIVERED COD shipments from the last 180 days, at most once per 12 h each, always with testMode=0.
  - Payout known → Fulfillment.codStatus PAID, status COD_PAID, plus an event. COD registered but not paid → REGISTERED.
- Scheduling: stately pg-boss queues with accountId in every payload. The 15-min eushipments.tick queues products, stock, orders and bookings. The daily eushipments.daily (03:41 UTC) re-tests every connection that has a token, then queues reference data (couriers, warehouses, countries, offices) and COD. Cities are synced on demand per country; Great Britain (countryId 23) is refused, as the spec says.
- Pollers only read connections that are enabled and have a token, a companyId and a passed connection test. A change of token or euShipments company resets the test.
- Connections (src/server/eushipments/connections.ts):
  - A new connection always starts READ_ONLY. There is one connection per euShipments company inside a group.
  - A token can be reused for another euShipments company of the same group.
  - The euShipments company is locked once shipments exist.
  - Raising the mode needs an OWNER plus a ready connection (token, company, passed test).
  - Raising the CANARY daily cap is OWNER-only.
- Permissions: new "eushipments.sync" (OWNER, ADMIN, OPERATOR, WAREHOUSE) for manual read syncs.
- UI: /warehouses/eushipments (list + create form) and /warehouses/eushipments/[id] (mode stepper, sync freshness, 8 mirror tabs showing our name with the vendor's original name under it, settings, token rotation).
  - The DRY_RUN tab lists OutboundRequests evaluated in DRY_RUN: the exact body, whether it went with testMode: true (createOrder, createTransfer) or was only recorded, and the vendor's validation answer.
  - The shared Складове and Продукти pages each gained one entry-link component.
- Fixtures: there is no FHB fixtures:record on main, so euShipments got its own pieces.
  - src/integrations/eushipments/fixtures/scrub.ts classifies every response field per endpoint and replaces sensitive values with deterministic synthetic ones of a recognisable shape. Unknown fields are reported and the file is refused.
  - src/server/eushipments/record-fixtures.ts + tools/record-eushipments-fixtures.ts (<accountId> <connectionId>) write __fixtures__/recorded/<endpoint>.json.
  - The test fails if any recorded file contains a value the scrubber did not produce. One synthetic sample (recorded/get-products.json) keeps the test meaningful. Built, NOT run.

**Integration notes / for the merger:**
- I did not add a package.json script. When merging with the FHB track's `pnpm fixtures:record`, have it dispatch to tools/record-eushipments-fixtures.ts for EUSHIPMENTS connections.
- The e2e seed adds one euShipments connection, two products and one manual order (ACCEPTED, E2E-2001) to the shared e2e database. Existing specs should be unaffected, but shell-spec screenshots of /warehouses and /products will now show the euShipments link cards.
- CLAUDE.md asks for the auditor subagent before every commit. No agent tool was available in this run, so no audit was done. Run the auditor on wave1/eushipments before merging.

**Open points / things to check:**
1. The DRY_RUN preview shows recipient data from the payload to every member who can open the page (account.read). Consider restricting it to orders.review.
2. Part 1 behaviour: in DRY_RUN, queueEuOrder still moves the Order and Fulfillment to QUEUED and they stay there after the testMode validation. The pipeline task (P4-03) should decide what a dry-run order looks like.
3. Products sync uses one transaction per row every 15 min. Fine for a few thousand products; batch it if catalogs grow.
4. Vendor date fields are read as Europe/Sofia time (the open question from part 1 still stands).
5. The three items listed under "blocked" (no reference screenshots, no barcode in get-products, CUST_NAME attribution) need answers before they can be closed.

## fix:fhb
BLOCKED: []
I checked every finding against the code and the reference, and all of them held. Each fix has a regression test in src/server/fhb/fhb-write.test.ts, or in the validators and client tests for the LOW items.

HIGH, the update dropped the carrier, pick-up point and note: updateFhbOrder now fills in what the caller does not pass from the stored shipment: parcelService from Fulfillment.carrier and deliveryPoint from Fulfillment.deliveryPoint.code. pickupPoint is now `input.pickupPoint ?? (stored point || new point)`, so a pick-up-point order stays one. Clearing the point without pickupPoint:false is blocked as a hard error. The note comes from the latest queued PUT body, otherwise from the create outbox payload. An explicit value, including null, still wins. The update also writes the new carrier and point back to the Fulfillment.

MEDIUM, stock check on updates: prepare() has a new `reserved` option. Updates credit the shipment's own FulfillmentLine quantities per CRM product back onto FHB free_quantity. This only happens when the stock snapshot is newer than Fulfillment.submittedAt, because an older snapshot does not include the reservation yet.

MEDIUM, stale variable symbol: the symbol is now taken with an atomic `variableSymbolNext: { increment: 1 }` after the connection lock. A test runs 5 concurrent submits and gets symbols 1 to 5 with next = 6.

MEDIUM, A→B→A: new src/server/fhb/revision.ts updateRevisionKey(). Keys are `{prefix}:r{n}`, used for orders, products and stock receipts. The latest revision is reused only when its body is the same, so a double click is still one request. Any other body gets a new revision, so the final A is sent again. Product and receipt updates now also take the connection lock.

MEDIUM, stock receipt ids: createFhbStockReceipt now requires `requestToken` (8–100 chars, [A-Za-z0-9_-]). externalRef is `IN-` + the first 16 hex characters of sha256(accountId, connectionId, token). The same token returns the existing inbound and request with created:false, and a unique-violation race is retried once. There is a new resubmitFhbStockReceipt(actor, inboundId, input) for SUBMIT_FAILED or never-sent QUEUED receipts. It keeps the same ref and create key, and is refused once FHB holds the receipt. There is no UI caller yet; the future inbound form must generate the token when it opens.

MEDIUM, docs: I updated INTEGRATION_NOTES: the /api/webhooks callback URL shapes with the shipment id and why it is there; the §2.4 mapping (returned → RETURN_RECEIVED, rejected → BLOCKED + task) and the reason; unwrapped response bodies; the undocumented 404 on GET /order; the PUT body list (POST minus id, validate and invoice_number) and the rewrite rule; the stock credit; update revision keys; and the rounding gap. I did NOT edit PROGRESS.md or BACKLOG.md because the hard rules forbid it. For the orchestrator: mark P2-01 to P2-08 [x], and add a PROGRESS entry with these decisions and the gaps below.

LOW items, all fixed: the FHB vault hint now comes from the app id (`app ••••xxxx`), using a new optional `hint` on saveCredential. A failure to build the client is stored only as `no_client: no_credentials|not_found|credentials_unreadable`, via clientFailureCode(). There is a new soft pre-flight finding fhb.cod.fractional for HUF (WHOLE_UNIT_COD_CURRENCIES). The FhbClient semaphore is now held only around the fetch, not across backoff sleeps or login.

Known gaps:
- Per-country rounding rules and the rate/conversion display are still missing; there is only the HUF soft finding.
- updateFhbOrder does not rewrite FulfillmentLines after a PUT, so the stock credit is based on the lines last stored at submit.
- Fulfillment.carrier and deliveryPoint now hold the operator's latest queued intent even if FHB later refuses that PUT. Apply overwrites the carrier from FHB's view on the next read.

## fix:eushipments
BLOCKED: [{"id": "LOW-backlog-progress", "reason": "The task says not to edit docs/BACKLOG.md or docs/PROGRESS.md. The orchestrator should mark P3-01..P3-06 [x]. Put these under [!] with their questions: (1) How do we read back the barcode after create-product? (2) Is a testMode create-order answer of {orderId:null, error:false} a pass? (3) What time zone are the vendor dates (read as Europe/Sofia for now)? (4) Is CUST_NAME in get-prod-avails exactly the get-user-companies NAME? (5) Screenshot coverage. Then copy notesForProgress into PROGRESS.md."}, {"id": "auditor-subagent", "reason": "No Agent/subagent tool exists in this headless run, so I could not run the auditor before the commit. typecheck, lint, unit tests and my e2e spec all passed."}]
All findings were checked against the code and the vendor reference before fixing. Each fix has a regression test.

HIGH
1. Orders and bookings stuck after a request that never reached the vendor.
   - queueEuOrder now re-queues the same reference when two things hold:
     - the Fulfillment is QUEUED or SUBMIT_FAILED;
     - the `order:<ref>` request is DRY_RUN_RECORDED, REFUSED or FAILED (a local copy of the outbox REARMABLE set; outbox.ts is untouched).
   - Anything SENDING, PENDING, SENT or UNCERTAIN throws duplicate_reference and does not flip the Fulfillment back to QUEUED.
   - A re-queue also rewrites the FulfillmentLines and deliveryPoint, because the order may have been edited.
   - queueEuBooking re-arms the existing InboundShipment (same documentNumber) under the same rule, replacing its lines. It runs under a per-document lock.
   - Tests:
     - DRY_RUN → raise to LIVE → re-queue → SENT exactly once.
     - READ_ONLY → REFUSED → LIVE → re-queue → SENT, then a further re-queue is a duplicate.
     - Booking: DRY_RUN → LIVE → re-queue.
2. Stock pre-flight added to queueEuOrder.
   - Σqty per VendorProduct is compared with StockLevel free − reserved.
   - Blocks: insufficient_stock (field products[i].qty) and no_stock_snapshot.
   - Warning: stock_snapshot_stale, when snapshotAt is older than the new EushipmentsSettings.stockStaleHours.
   - Default is 30 h, because the reference example shows a daily 06:00 AVAIL_DATE snapshot. It can be changed in the settings form.
   - Nothing writes StockLevel.reserved yet, so reservations count as 0 until phase 4.
3. rowsForCompany now counts rows whose CUST_NAME matches none of the token's companies as unattributed. It flags `ambiguous` when two companies share a normalised name.
   - With several companies on the token, syncEuStock throws stock_unattributed or stock_company_ambiguous when no rows can be attributed (or the names are ambiguous) and rows exist.
   - StockLevel and EushipmentsStock stay untouched, and the error shows in sync freshness.
   - An empty get-prod-avails answer still zeroes the stock, as the existing tested behaviour does.

MEDIUM
4. Every live create-order now calls orders-history before sending.
   - The stored body is Zod-checked first, so an invalid body causes no call at all.
   - found → orderCreated(recovered) and accepted, with no create-order.
   - found but Deleted/Cancelled → rejected with an operator task (orderRejected). A second shipment with the same reference would make tracking ambiguous.
   - error or unreadable → EuShipmentsError unknown_outcome. The outbox then reads back and retries on not_found, or marks UNCERTAIN.
   - testMode sends skip the check.
   - Test fixtures now answer orders-history with not-found by default.
5. waybillAvailableDate is set to max(stored, sofiaToday(now)) in the transport at send time, for both live and testMode sends. Because it only moves forward, it stays inside the +9 window checked at queue time. The transport takes an injectable now().
6. queueEuTransfer requires `requestKey` (uuid).
   - The row id is that key, and externalRef is derived from it, so the PK is the unique constraint. It runs under a per-key lock and retries once on P2002.
   - A repeat call returns the existing row and request, re-armed only when nothing was created.
   - No UI calls it yet. A future form must render a nonce.
7. Service-level duplicate-submit tests added: sequential, concurrent (Promise.allSettled) and in-flight SENDING.
8. Effect failures call the new deps.onEffectFailed. In production this is effectFailureAlert, which opens a CRITICAL, isTask alert of kind eushipments_effect_failed on the OutboundRequest, with the reference in the body.
9. DRY_RUN tab:
   - mirrorDryRuns(accountId, connectionId, role) asserts orders.review.
   - It returns payload.body only; ctx (ids, invoice PDF) is never returned.
   - The tab is hidden for other roles, and the tab content refuses them too.
   - Masking was not needed, since roles without orders.review never get the data.
10. euCredentials(actor) only offers a token when every connection using it is inside the actor's company scope. createEuConnection checks the same. This is defense in depth: companies.ts never restricts ADMINs today, so the finding's scenario cannot happen yet.
11. ORDER_FROM / advanceOrderStatus in statuses.ts: the Order follows its shipment forward only, in the same transaction.
   - It never moves back and never overwrites ON_HOLD.
   - COD_PAID applies only from DELIVERED (pollEuCod).
   - An order deleted at the vendor (orderDeleted) is NOT moved to CANCELLED, because the shipment may be re-routed. This is a phase-4 decision.

LOW
- pollEuCod: per-reference try/catch records codCheckedAt and lastError. It fails the job only if every check failed; auth_failed is still rethrown.
- company_locked: the company also locks when any OutboundRequest is SENDING, SENT or UNCERTAIN outside DRY_RUN, or when a booking has a vendorId, or a transfer is CREATED. Mirrored read-side VendorProducts deliberately do NOT lock it, otherwise one product sync would lock a wrongly picked company forever.
- stopsPolling: "Claim opened" keeps polling at the normal 15-min cadence until "Compensation paid" or another status arrives. There is no separate low cadence.
- Job payloads are Zod-parsed (EuConnectionJob, EuCitiesJob via parseEuJob). A malformed job throws, so pg-boss fails it into the queue's dead-letter.
- BACKLOG/PROGRESS: not edited, per the task. See blocked.
