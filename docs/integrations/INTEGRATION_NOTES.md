# Integration notes — read this before touching any adapter

This file is the curated, opinionated layer on top of the full vendor references in this folder
(`fhb-kika-v3.md`, `fhb-joy.md`, `eushipments.md`, plus the untouched originals in `raw/`).
The full references are the source of truth for field names and types. This file is the source of truth
for **how we use them**, the traps, and the mapping from our CRM model to each vendor.

Specs captured: 2026-10-28. FHB v3 changelog last entry 2026-07-29. euShipments booking v1.1 (Oct 2026),
status list "current as of July 2026".

---

## 0. Systems at a glance

| | FHB Kika API v3 (fulfillment) | FHB Joy API (labels only) | euShipments (inout.bg) |
|---|---|---|---|
| What it is | Full fulfillment: products, orders, stock, receipts, returns, COD | Label printing on FHB carrier contracts for parcels we pack ourselves | Fulfillment + courier AWBs + bookings + transfers |
| Prod base | `https://api.fhb.sk/v3` | `https://system.fhb.sk/api/joy` | `https://api1.inout.bg/api/v1` |
| Test option | **Not used** (we run production only; a sandbox exists at `api-dev.fhb.sk/v3`). **No test flag in production** — every write is real | None — every label is real (can be rejected while `printed`) | Production accepts **`testMode: true`** ("applies only to the production environment") — our validation pass, see §6 |
| Auth | `POST /login {app_id, secret}` → token; send `X-Authentication-Simple: base64(token)`; token expires (`expiration` in response) | `POST /login {appId, secret}` (camelCase!) → token valid 6h; same header, base64 | Static `Authorization: Bearer <token>` issued by euShipments |
| Creds from | ZOE: https://zoe2.fhb.sk | ZOE: https://zoe2.fhb.sk/api | Requested from euShipments support |
| Field style | snake_case | camelCase (and `psc` vs `zip` inconsistency) | camelCase in requests, UPPER_CASE in many responses |
| Push events | Yes: per-order `notification` URLs + per-product `notify_url` for stock | Yes: `_embedded.notifyLinks` | **No webhooks** — must poll |
| Error shape | `400 {message, violations: {"field.path": [{code, message}]}}`; `401 {message}`; `404 {message}` | `{status:"error", message, id:<field>}`; 405 = id in wrong place; 409 = exists / wrong state | `{error, code, message?}` with HTTP 400/401/404/409/422/500/503; text errors. **Some calls return per-item errors inside HTTP 200** (orders-history, COD) — always inspect each item |

---

## 1. Universal rules for all three adapters

1. **Idempotency first.** Every outbound create uses a deterministic external id derived from our record
   (never random). Before any retry after a timeout/5xx, READ BACK by that id
   (FHB `GET /order?id=`, Joy `GET /shipment?id=`, euShipments `orders-history` by `refNum`). Only re-send if
   the read-back proves the order does not exist. A duplicate shipment is the worst failure mode.
2. **Outbox pattern.** Writes go through a `outbound_requests` table (payload, attempt, response, status).
   The worker sends; the UI never calls vendors directly. Every request/response is stored (PII-redacted copy
   retained per retention policy) for audit and for the AI learning loop.
3. **Validate locally before sending** using the per-vendor validators in section 5. A vendor 400 should
   be rare; when it happens, map it to the exact UI field (FHB gives dotted paths like `recipient.address.zip`).
4. **Token handling.** Cache FHB/Joy tokens per credential set until `expiration - 5 min`; on any 401
   re-login once and retry once.
5. **Unknown enum values never crash.** Store the raw status string/ID, map through a table, default to
   `UNKNOWN` and raise an alert so the mapping gets extended (FHB already returns statuses that are not in
   its documented list — see 2.4).
6. **Null means JSON null.** euShipments explicitly rejects the string `"null"`. Never stringify nulls.
7. **Respect page sizes:** FHB product/all 250, order/history 100, rma/list 100, stock/movements 500;
   euShipments orders-history 1–100 refs per call; Joy labels max 100 ids.
8. **No rate limits are documented by any vendor.** Default to max 4 concurrent requests per credential set,
   exponential backoff on 429/5xx, jitter. Make it configurable.

---

## 2. FHB Kika API v3

### 2.1 Identifiers (critical)
- `product.id` — our pairing key, immutable, unique. Avoid `#`, `&`, `%`. Our convention: Shopify variant SKU
  with the connection's prefix (FHB account currently uses an **`R` prefix** on the store SKU, e.g. `RSK…`).
  Prefix rule is configured per fulfillment connection, never hard-coded.
- `product.ean` — **FHB may correct it to the real EAN on the box. Never overwrite FHB's EAN from Shopify.**
  The same product can arrive with different EANs per batch, so EAN is never a join key. Send EAN only on
  create; on update, omit `ean` unless a human explicitly edits it in the CRM.
- `order.id` — unique per FHB account. Several Shopify stores share one FHB account, so the id must include a
  store code: `{STORECODE}-{shopify order number}` (e.g. `PZA-10234`). Store codes are unique per FHB account.
- `order.variable_symbol` — **required, unique, digits only, max 10 chars.** Shopify order numbers collide
  across stores, so allocate from a per-FHB-connection numeric sequence and store it on our order.
- `order.uid` — FHB internal id, returned on create; store it.

### 2.2 Products
- `POST /product` create, `PUT /product?id=` update (send `new_id` to rename), `GET /product?id=`,
  `GET /product/all?page=` (250/page), `GET /product/archive?id=` (archives; 204).
- `name` max 150, `photo` URL max 255, `notify_url` max 255.
- Bundles/sets: `type: "multi"` with `items[{id, quantity}]`. Components must be existing, active, single.
  Promote single→multi via PUT is allowed; **multi→single is not** (`DEMOTE_NOT_SUPPORTED`).
- `customs_information {hs_code, country_of_origin, purchase_price}` — fill for non-EU flows.
- Stock fields on product: `stock_quantity` (physical) and `free_quantity` (what remains after open orders).
  **Use `free_quantity` as sellable stock.** `/stock/all` only returns `quantity` (physical).
- Stock push: set `notify_url` on every product to
  `https://<crm>/webhooks/fhb/{connectionId}/stock/{signedToken}`. Body: `{id, type(in|out), qty,
  stockQuantity, reason, serialNumbers[]}`; reason codes `1` manual, `2` sent order, `3` receipt,
  `4` returned order, `5` cancelled order. No signature is documented → the secret lives in the URL path;
  validate it and still treat payload as a hint (re-read `GET /product?id=` before trusting numbers).

### 2.3 Orders
- `POST /order` body essentials: `id`, `variable_symbol`, `recipient.address{name, street, city, zip,
  province?, country(ISO-2)}`, `recipient.contact{email ≤50, phone ≤20 international}`, `items[{id, quantity≥1}]`.
- Options: `parcel_service` (code from `GET /parcel-service`), `delivery_point` (+ `delivery_point_parameters`
  when the service requires them), `cod`, `value` (insurance), `sender`, `validate`, `note` ≤250,
  `invoice` (PDF URL), `invoice_number`, `invoice_date`, `print_delivery_note`, `print_sscc`,
  `invoice_detail` (customs, non-EU), `notification{confirmed, sent, delivered, returned, ticket_created,
  ticket_updated, ticket_closed}`.
- **COD must be in the destination country's local currency** (CZ→CZK, HU→HUF, PL→PLN, RO→RON, HR/SK/SI/BG/GR→EUR).
  Keep the country→currency table in the database, not in code. If the Shopify order currency differs from the destination's currency,
  convert with a stored daily rate, round per country rules, and show the conversion to the operator.
  Same for `value`.
- **Always send `validate: true`** so FHB refuses undeliverable addresses at import instead of later.
- Email > 50 chars: block in pre-flight (FHB will reject). Phone: normalise to E.164 (`+…`), ≤20.
- `PUT /order?id=` and `DELETE /order?id=` work **only while status is pending**. PUT replaces the line set
  (kept lines keep their reservation, omitted lines are removed).
- `PUT /order/invoice?id=` customs only, allowed in raw statuses `new`, `imported`, `b2b_new`, `packed`.
- `POST /order/files` attach files (e.g. invoice PDF).
- `GET /order?id=` or `?tracking=` full detail incl. `tracking_numbers`, `tracking_links`, `tracking_events`,
  `packages[]`, `package_returns[]`, `proof_of_delivery`, `created_at/shipped_at/delivered_at/returned_at`,
  `return_type` (`return|claim|write_off`), `sscc`, `packing_packages`.
- `GET /order/history?from&to&status&page` 100/page — the reconciliation sweep.
- Order webhooks: put signed URLs in `notification.*` on create:
  `https://<crm>/webhooks/fhb/{connectionId}/order/{event}/{signedToken}`. Payload format is not documented →
  on any call, re-read `GET /order?id=` and update from that. Do not parse the body as truth.

### 2.4 Status mapping (documented vs observed — handle both)
Documented: `pending, confirmed, sent, delivered, rejected` (+ `returned` accepted as history filter).
Seen in responses/other endpoints: `imported, new, b2b_new, packed`.

Edit (`PUT /order`) and cancel (`DELETE /order`) are documented as allowed **only in `pending`**
(otherwise 400 `NOT_UPDATABLE_ORDER_ERROR`). Do not assume `new`/`imported`/`b2b_new` are editable: offer
Edit/Cancel in the UI only when raw status is `pending`, and treat a 400 on the attempt as "locked".

| FHB raw | CRM fulfillment status |
|---|---|
| pending | ACCEPTED (editable/cancellable) |
| new, imported, b2b_new | ACCEPTED (treat as locked until proven otherwise) |
| confirmed, packed | PROCESSING (locked) |
| sent | SHIPPED |
| delivered | DELIVERED |
| returned (or `returned_at` not null) | RETURNED |
| rejected | REJECTED (needs operator) |
| anything else | UNKNOWN + alert |

### 2.5 Stock, inbound, returns, COD, carriers
- `GET /stock/all`, `GET /stock?id=`, `GET /stock/history/{date}`, `GET /stock/movements?product&receipt&reason&from&to&page` (500/page).
- Inbound = **stock receipt**: `POST /stock-receipt {id ≤255, name ≤50, delivery_service?, tracking_code?,
  expected_date?, is_bianco?, items[{id, quantity}]}`; response gives `received` per line. PUT (modify) and
  DELETE are both allowed only while status is `created`.
- Returns from carrier (undelivered/refused, not storno): `GET /rma/list?from&to&page` (filter is on return
  date, sort is on order creation date).
- Local depot returns (paid extra service — may return nothing): `GET /return/list`, `GET /return/{uid}`,
  photos via `GET /return/{uid}/photo/{photoId}`.
- COD: `GET /cod?id=`, `GET /cod/list?status` with `waiting | received | paid`.
- Carriers: `GET /parcel-service` → `[{code, name}]`. PUDO: `GET /delivery-point/{code}?country=`;
  **`country` is mandatory for `gls_eu_pudo` and `dpd_eu_pudo`**; 404 means "none in that country".
- Default couriers per country (business choice, quality over cost): HU→GLS, CZ→PPL, PL→InPost,
  SI→DPD, HR→DPD; other countries use FHB recommendation once confirmed. Store as editable routing rules;
  resolve names to real codes from `/parcel-service` at runtime, never hard-code codes.

---

## 3. FHB Joy API (label printing / manual parcels)

Use for **manual shipments we pack ourselves** (replacements, samples, B2B parcels) using FHB's carrier
contracts. Separate base URL, separate auth call, camelCase.

- `POST /login {appId, secret}` → token 6h.
- **Id placement rule:** POST → `id` in JSON body (sending `?id=` gives 405). GET/PUT/DELETE → `id`
  (or `ids`, `parcelService`) in the query string (omitting gives 405).
- Synchronous: `POST /shipments` creates + returns `packages[{id, tracking}]` and `label` (base64 PDF).
  Required: `id, parcelService, name(≥3), street(≥3), city(≥2), zip(3–12), country, email(≤50),
  phone(6–20 intl), variableSymbol, numberOfPackages`. Optional: `province`, `cod` (local currency!), `weight[]`
  (length must equal numberOfPackages), `deliveryPoint`, `labelOrientation P|L`, `sender`, `senderName`,
  `note`, `invoiceDetail` (customs), `_embedded.notifyLinks[{confirmed,sent,delivered,returned}]`.
  `variableSymbol` must be numeric ≤10 for `posta_expres`.
- Asynchronous: `POST /packages` — note **`psc` (3–10)** instead of `zip`, `id` ≤30, name 3–100,
  street 3–255, city 2–50, `variableSymbol` ≤40, `note` ≤250. **`parcelService` is optional and silently
  defaults to `joy`** — always send it explicitly. `numberOfPackages` optional (default 1).
  `PUT /packages?id=` and `DELETE /packages?id=` only in `imported` state. Read-back: `GET /packages?id=`.
  Labels via `GET /labels?id=` or `?ids=a,b,c` (≤100, A6 PDF).
- Reprint: `GET /shipments?id=` — **not possible > 5 days after creation**.
- Cancel: `DELETE /shipments?id=` only in `printed` state (409 otherwise).
- Info: `GET /shipment?id=` → status `pending|confirmed|sent|delivered|returned|rejected|undefined`,
  tracking numbers/links/events (`_embedded` may be `[]` when empty — handle array-vs-object).
- 409 on create = id already exists → read back, never auto-retry with a new id.
- Packing lists: `POST/GET/DELETE /packing-list`, `POST/DELETE /packing-list-item` (handover manifests).

---

## 4. euShipments (inout.bg)

### 4.1 Account structure
- One API token can see several **companies**: `GET /get-user-companies` → `ID` = `companyId`/`senderId`.
  Store the mapping CRM account → euShipments companyId (one per legal entity).
- `GET /couriers/{companyId}`, `POST /fulfilment/warehouses`, `GET /get-countries`, cities, offices.
- Many calls require **`testMode`** in the body. Always send it explicitly (`0`/`false` in prod).

### 4.2 Products
- `POST /fulfilment/create-product {testMode, companyId, product{name ≤200, barcode ≤50, refNumber ≤100,
  description? ≤500, length, width, height (0.1–999 cm), weight (0.01–999 kg)}}` — the four dimension
  fields are **required flat fields**; keep them on our Product master and block creation when missing.
- `refNumber` is the join key used in orders and bookings; **must be unique within the company** (422 if it
  exists). Use the connection's SKU prefix rule (e.g. a company whose SKUs carry a country prefix such as `SK-`).
- **`barcode` must be unique across the whole euShipments system** (422 "This barcode is not unique for our
  system"). The same perfume EAN under two of our companies (e.g. two client companies at euShipments) will collide, and
  in rare cases a collision creates the product without a barcode. Handling: try the known EAN; on the
  uniqueness error, ask the operator (offer an internal barcode such as the prefixed SKU) — never retry
  blindly. After creation, read back via `get-products` and check the barcode actually stored.
- `GET /fulfilment/get-products?companyId=` → `[{ID, NAME, DESCRIPTION, LENGTH_ITEM, WIDTH, HEIGHT, WEIGHT,
  REFERENCE_NUMBER}]` (503 = no access to that company).

### 4.3 Orders (fulfilment)
- `POST /fulfilment/create-order`. **An order is accepted only if stock is available in the warehouse**
  (spec). Our pre-flight must check `get-prod-avails` (a snapshot with `AVAIL_DATE`; show its age and
  warn when older than the configured threshold). Note: the observed "blocked orders" in status
  *Information received* / *Insufficient data* are our operational reading of the problem, not something
  the spec describes — treat long stays in those statuses as alerts (see 4.5).
- Required: `testMode`, `senderId`, `waybillAvailableDate` (today … +9 days), `recipient.name ≤100`,
  `recipient.phoneNumber`, `recipient.streetName` (unless `officeId`/`officeCode`), and either `cityId` or
  `countryIsoCode` (uppercase) + `cityName`, plus `zipCode` unless `region` is sent (`region` required for
  Romania), `awb{parcels, envelopes (may be 0), totalWeight ≥0.01, referenceNumber ≤100}`.
- **`awb.referenceNumber` uniqueness is NOT enforced by the API** — the spec only says it must be unique
  "to avoid duplicate shipments". We enforce it: unique constraint in our DB, and before any (re)submit
  call `orders-history` with that refNum. A missing order comes back inside HTTP 200 as an item with
  `error: "Not found order…"`, `errorCode: 404` — that (and only that) means "safe to send".
  Use the same `{STORECODE}-{number}` as everywhere.
- Content: `products[{refNumber, qty, price?, priceWithoutVat?}]` or `boxes[{refNumberBox, items[]}]`.
  For senders with Econt/Speedy cash-receipt config: **Σ(price × qty) must equal `awb.bankRepayment`**
  or the order is rejected — compute prices from Shopify line totals after discounts, then fix rounding on
  the last line.
- COD = `awb.bankRepayment`; `awb.shipmentPayer` only `sender|recipient`; `observations` ≤300 (notes);
  `courierId` optional (auto-assigned if omitted); `serviceName` one of `crossborder`,
  `eushipmentsairexpress`, `eushipmentsglobal economy`, `eushipmentsglobal premium`.
- `buildingNumber`: only the first 8 chars are kept, rest is appended to `addressText`.
  `addressText` is truncated to 100 chars on store. Pre-flight should warn when truncation will happen.
- Non-EU: `customsData{dutyPaymentInfo DDU|DDP, customsValue}` and/or `customs_declaration{products[], exportData{…, ioss_number}}`.
- Response: `{orderId, error, code}`; store `orderId`.
- PUDO/office: **use `recipient.officeId`** from `GET /offices-by-courier/{courierId}` (the docs contradict
  themselves on the `streetName` keyword — "to office:" vs "office" — so never rely on it).
- Delete: `DELETE /orders-delete/{refNumber}` or `/orders/{id}` — only in *Information received*,
  *Awaiting pickup* or *New*, and **not older than 14 days**.
- Attach invoice: `POST /fulfilment/attach-pdf-files` — **only before the AWB is generated** (422 after),
  one file per request, content must be a real PDF (signature checked). Attach immediately after create.

### 4.4 Phone rules (from euShipments guidelines — apply in pre-flight)
| Country | Format |
|---|---|
| RO, BG, GR, PL | national number **without** country prefix |
| CZ | `+420` / `00420` + 9 digits |
| HU | `+36` / `0036` + 9 digits — strip national `06` first (`06 30 123 4567` → `+36301234567`) |
| SK | `+421` / `00421` + 9 digits |
| HR | `+385` / `00385` + 9 digits |
Never send two prefixes. Store the original phone; send the normalised one; show both in the UI.

### 4.5 Status tracking (polling, no webhooks)
- `POST /fulfilment/orders-history {testMode, orders:[{refNum}] (1–100)}` → per order `awb`,
  `newReturnNumber`, `statusesHistory[{ID, STATUS, DATE, DATE_CREATED, COMMENT, PARTNER_VOUCHER}]`, `items`.
  **`statusesHistory[].ID` is a record id, not a status id.** Status must be mapped from the `STATUS`
  text. Per-item `error`/`errorCode` inside HTTP 200 must be checked.
- AWB level: `GET /get-status/{awb}` returns text only (`{"status": "Delivered"}`, plus the special value
  `"canceled/deleted"`); `GET /get-status/history/{awb}?lang=EN`; `GET /get-awb/{awb}` (unknown AWB → 422,
  not 404); courier call log `GET /check-actions/{awb}`.
- COD: `GET /check-cod-by-order/{referenceNumber}?testMode=` — keyed by our reference; "nothing found" is
  HTTP 200 with a null body.
- Poll cadence: open orders every 15 min in batches of 100; orders in final status stop polling,
  except returns which are polled until *Returned to Warehouse* / *Product returned to stock*.

**Status mapping is by `STATUS` text.** Normalise before matching: trim, lowercase, replace Cyrillic
look-alike letters with Latin (spec has "Оn hold" with a Cyrillic О), unify dashes (spec uses a plain
hyphen in "Insufficient data - AWB not created"). Keep the mapping in a DB table seeded from the list
below (full list with "final" flags in `eushipments.md`); any unmapped text → UNKNOWN + alert.

| STATUS text (spec ID for reference) | CRM | Alert |
|---|---|---|
| New (7), Information received (20), Information sent to warehouse (23), Awaiting pickup (21), PreAlert (28) | ACCEPTED | if still here after N hours (configurable; default 24h on working days) |
| Packed (19), Scanned Waybill (18), Repackaged (74), Warehouse Pickup (47), Lastmile Accept (31) | PROCESSING | |
| any "Warehouse …" (16, 26, 30, 32, 33, 39, 45, 46, 48, 50, 68, 71, 75, 80, 86, 89), "Loaded hub …" / "Unloaded hub …" (55–66, 69, 70, 72, 73, 76–79, 81, 82, 87, 88, 90–93), Linhaul transit (41), Linehaul loading (49) | IN_TRANSIT | |
| In transit (2), On delivery (1), In the office (5), Redirected (14), Picked up (51) | IN_TRANSIT | |
| Unsuccessful delivery attempt (44) | IN_TRANSIT | warn |
| **Insufficient data - AWB not created (22), Insufficient data (43), Stockout (11), Wrong recipient data (40), Оn hold (37)** | **BLOCKED** | **immediate** |
| Delivered (3), COD paid (6) | DELIVERED | |
| Returning (17), Returned (4) | RETURNING | |
| **Returned to Warehouse (34), Product returned to stock (42), Returned to Client (36)** | **RETURN_RECEIVED** (closes the "was the return physically received?" gap) | notify support |
| Cancelled (8), Deleted (15), `canceled/deleted` (get-status) | CANCELLED | |
| Cancel (38) — spec marks it **not final** | CANCEL_PENDING (keep polling) | |
| Lost shipment (13), Damaged shipment (27), Destroyed (29), Rejected by courier (35), Claim opened (25), Compensation paid (24), COD Blocked by Authorities (54), Under investigation (67), Underaudit (53), Search cancelled (52) | EXCEPTION | yes |
| anything else | UNKNOWN | yes |

### 4.6 Inbound (booking requests) and transfers
- `POST /fulfilment/create-request {testMode, companyId, warehouseId, courierInc?, trackNumb?,
  deliveryDate?, packagesCount?, clientReference?, ref1–3?, products[{refNumber, quantity}]}` → `requestId`.
  `clientReference`/`ref1–3`: **printable ASCII only, ≤100, immutable, not searchable, not unique** — put
  our inbound document number there anyway (it comes back in status calls). Duplicate refNumbers are merged
  and summed. If `courierInc`/`trackNumb`/`packagesCount` are sent they must be non-empty.
- **No idempotency for booking requests.** A timed-out create cannot be read back. Rule: never auto-retry;
  mark the inbound as UNCERTAIN and create an operator task to check the euShipments cabinet before
  resubmitting.
- `GET /fulfilment/get-request-status/{id}`; `POST /fulfilment/booking-request-status {companyId, bookingId}`
  → lifecycle (`created, received, closed, deleted`) + per-product booked vs accepted qty + warehouse comment.
  Accepted qty differing from booked qty → discrepancy task.
- Stock per warehouse: `GET /fulfilment/get-prod-avails` (no params; one row per product per warehouse).
- Transfers/scrap: `POST /fulfilment/create-transfer` requires **`externalRef` (≤100, unique per company)**;
  resending the same externalRef returns 409 `DUPLICATE_EXTERNAL_REF` with the existing protocol, so
  retries are safe — use a deterministic externalRef. `testMode: true` validates without persisting
  (dry-run).

### 4.7 Non-fulfilment courier AWBs
`createAWB` (incl. pallet and non-EU variants), `preAWB`, pickup AWB, `shipment-price` (quote),
`print/{awb}`, `merged/print`, `delete/{awb}`, `waybills-history`, `expedited-shipments`.
Used for manual shipments that do not leave the euShipments warehouse stock.

---

## 5. Pre-flight validators (run on every order before "Fulfill" is enabled)

Hard blocks (cannot submit): missing required field; email > 50 (FHB/Joy); phone not normalisable for the
destination; COD currency not convertible; SKU without a product mapping for the target connection;
mapped product missing at the vendor; insufficient free stock (FHB `free_quantity`, euShipments avails
minus CRM-reserved); duplicate external id/reference; PUDO order without a valid delivery point/office;
euShipments Σ(price×qty) ≠ COD where cash-receipt config applies; `waybillAvailableDate` outside window.

Soft warnings (operator must acknowledge): street without a house number; zip/city mismatch for country;
name looks like a company/garbage; text will be truncated (euShipments building number/addressText);
stock snapshot older than threshold; repeat customer with previous refusals/returns; same address/phone
with multiple open orders; Shopify risk level medium/high; customer note present.

Every validator returns `{code, severity, field, message_bg, message_en, suggestedFix?}`. The AI layer
consumes the same structure (see SPEC.md §7).

---

## 6. Production-only rollout (no sandbox)

We integrate directly against production. Safety comes from staged modes per FulfillmentConnection,
enforced in the outbox sender:

| Mode | What is allowed | Exit criteria |
|---|---|---|
| **READ_ONLY** | Login + all GET/list calls. Mirror products, stock, orders history, receipts, returns, COD, carriers, PUDO into the CRM. Record fixtures (PII scrubbed). | Every response type parsed by our Zod schemas without errors for 3 days; SKU mapping coverage ≥ 99% |
| **DRY_RUN** | Build the exact payload for every real order, run all validators, show it in the UI as "would send". euShipments: send create-order / create-transfer with `testMode: true`. Nothing else is sent. | 200+ real orders dry-run with zero hard-block surprises; operator spot-checks payloads |
| **CANARY** | Real sends, but each one needs an explicit operator click on a confirmation showing the payload, and a daily cap (default 10). | 50 canary orders shipped and tracked end-to-end, statuses/write-back correct, no duplicates |
| **LIVE** | Normal operation incl. bulk Fulfill and (later) AI autopilot. | — |

Rules per vendor in production:
- **FHB v3:** no test flag — any POST /order is a real order. Products: create them in CANARY only after a
  dry-run review of the product list (wrong `id` is permanent; renames need `new_id`). An order sent by
  mistake can only be removed with `DELETE /order` while raw status is `pending` — wire a prominent
  "Cancel at warehouse" action and alert if a canary order leaves `pending` unexpectedly.
- **FHB Joy:** every label is real and billable. Test only with a real parcel you actually ship, or reject
  immediately (`DELETE /shipments` works only in `printed`).
- **euShipments:** `testMode: true` on production is documented as test usage; for transfers the spec says
  it validates end-to-end and persists nothing. **For create-order, confirm with euShipments support that
  `testMode: true` on production creates nothing visible to the warehouse** before relying on it in
  DRY_RUN. A real order sent by mistake can be deleted only in *Information received* / *Awaiting pickup* /
  *New* and within 14 days.
- **Shopify:** fulfillment write-back and inventory push follow the same modes per store
  (READ_ONLY → DRY_RUN preview → LIVE). Inventory push starts disabled.
- Kill switch: one OWNER action sets every connection of an account back to READ_ONLY and pauses the
  outbox; queued requests stay queued, nothing is dropped.
- Every production write is logged with request, response, user and mode, and visible on the order timeline.
