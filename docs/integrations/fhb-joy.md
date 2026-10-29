# Joy API — full API reference

_Auto-rendered from the vendor OpenAPI spec (raw file alongside). Servers: [{'url': 'https://system.fhb.sk/api/joy'}]_

API for printing shipment labels.

Converted from the original API Blueprint documentation (https://joylabel.docs.apiary.io)
and consolidated against the live implementation.

## Authentication

Every client has an `appId` and a `secret` (generated in the ZOE system,
https://zoe2.fhb.sk/api). Use them with `POST /login` to obtain an access token.
The token must be **base64-encoded** and sent on every other request in the
`X-Authentication-Simple` header. Tokens expire after 6 hours — re-login when they do.

## Resource identifiers

The routing mask is `api/joy/<resource>` with no id path segment, so the `id`
(and `order`, `parcelService`, `ids`) parameters are passed differently depending on the verb:

- **Create (POST)** — pass `id` (and `order` for packing-list-item) in the **JSON body**.
  Sending `?id=` on a create request yields `405 Method Not Allowed`.
- **Read / Update / Delete (GET / PUT / DELETE)** — pass `id` (or `parcelService`, `ids`)
  as a **query-string** parameter. Omitting it yields `405 Method Not Allowed`.

## Errors

Error responses use the envelope `{ "status": "error", "message": <string>, "id": <field> }`,
where `message` describes the failure and `id` (when present) names the offending field.
Common codes: `400` validation, `401` authentication, `404` not found, `405` wrong verb /
misplaced id, `409` state conflict.


## Section: Login

Obtain an access token. Every client has an `appId` and `secret` (generated in the ZOE system, https://zoe2.fhb.sk/api).


## Section: Shipments

Create and print shipment labels (synchronous), reprint existing labels, reject shipments and read shipment details with tracking.


## Section: Labels

Print labels for existing orders, individually or in bulk (up to 100).


## Section: Packages

Asynchronous order flow — create/update/read/delete packages; labels are fetched separately via the Labels endpoint.


## Section: Packing list

Create, read and delete packing lists.


## Section: Packing list item

Add or remove orders within a packing list.


## Section: Delivery points

List carrier pick-up points.


## Section: Anonymization

Internal / GDPR operation to irreversibly anonymize a closed order's personal data.

**Auth `AuthSimple`:** {"type": "apiKey", "in": "header", "name": "X-Authentication-Simple", "description": "Base64-encoded access token. Obtain a token via `POST /login`, then send it on every request as `X-Authentication-Simple: base64(token)`. Tokens expire after 6 hours \u2014 re-login when they do."}


---
## POST `/login` — Obtain an access token

Issues a temporary access token (valid 6 hours) for the given `appId`/`secret`.

**Request body** (application/json)

- `appId` **(required)**: string example='1234' — Application ID (32 characters).
- `secret` **(required)**: string example='1234' — Application secret (40 characters).

**Response 200** — Authenticated. Returns the access token and its expiration.

- `token` **(required)**: string example='A98ophrkh67' — Access token (max 80 characters).
- `expiration` **(required)**: string example='2014-07-08 15:00:00 +0100' — Date and time when the access token expires (6 hours after issue), formatted `Y-m-d H:i:s O`.

**Response 401** — Missing or invalid `appId` / `secret`.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

```json
{
 "status": "error",
 "message": "AppId or secret not valid"
}
```


---
## POST `/shipments` — Create and print a shipment label

Creates a shipment and returns the carrier tracking codes together with the base64 PDF label. The `id` is supplied in the body.

**Request body** (application/json)

- `id` **(required)**: string example='1003201' — Unique order identification code.
- `parcelService` **(required)**: string example='pplcz' — Preferred parcel service (must be a service enabled for Joy).
- `name` **(required)**: string example='Oskar Šnajdr' — Recipient name (min 3 characters).
- `street` **(required)**: string example='Hlavná 23' — Recipient street (min 3 characters).
- `city` **(required)**: string example='Horní Jasenka' — Recipient city (min 2 characters).
- `province`: string|null — Recipient province/region (optional).
- `zip` **(required)**: string example='75501' — Recipient ZIP code (3–12 characters).
- `country` **(required)**: string example='cz' — Recipient country code (ISO 3166-1 alpha-2; must be a known country).
- `email` **(required)**: string email maxLength=50 example='example@example.com' — Recipient email.
- `phone` **(required)**: string maxLength=20 minLength=6 example='+421901000000' — Recipient phone in international format (6-20 characters).
- `variableSymbol` **(required)**: string example='12345' — Variable symbol. For `posta_expres` it must be numeric and at most 10 characters.
- `cod`: number example=250 — Cash on delivery (default 0). WARNING: must always be in the delivery country's local currency.
- `sender`: string example='CUSTOMER_SENDER_CODE_1' — Custom sender reference. Must be one of the customer''s configured sender codes. Contact support to use multiple sender references.
- `senderName`: string — Custom sender name.
- `note`: string example='Note' — Order note (used by the fulfilment centre — not sent to the recipient).
- `numberOfPackages` **(required)**: integer example=1 — Number of packages.
- `weight`: array example=[1.45] — Weight of each package. If supplied, its length must equal `numberOfPackages`.
  - `[item]`: number
- `deliveryPoint`: string example='12451' — Delivery point code. Required when the parcel service delivers only to pick-up points.
- `labelOrientation`: string enum=L,P example='P' — Preferred label orientation — `P` (portrait) or `L` (landscape). Defaults to the carrier setting.
- `_embedded`: object
  - `notifyLinks`: array
    - `[item]`: object — Webhook URLs called on shipment status changes.
      - `confirmed`: string uri maxLength=255 example='http://example.com/order/1003201/confirmed' — Called when the package is confirmed.
      - `sent`: string uri maxLength=255 example='http://example.com/order/1003201/sent' — Called when the package is sent.
      - `delivered`: string uri maxLength=255 example='http://example.com/order/1003201/delivered' — Called when the package is delivered.
      - `returned`: string uri maxLength=255 example='http://example.com/order/1003201/returned' — Called when the package is returned.
- invoiceDetail (allOf):
    Customs declaration ("colné údaje") for a shipment.
  - `number` **(required)**: string example='202201397' — Invoice number.
  - `total` **(required)**: number example=353 — Total invoice amount.
  - `currency` **(required)**: string example='USD' — Invoice currency — uppercase ISO 4217 code (e.g. `USD`); must be a known currency.
  - `dateOfIssue` **(required)**: string date example='2022-11-30' — Invoice issue date (YYYY-MM-DD).
  - `products`: array — Invoice product lines with their customs data. Unlike the v3 API, no product `code` is required (we don't know the customer's code).
    - `[item]`: object
      - `description` **(required)**: string example='basic product' — Product description.
      - `hsCode` **(required)**: string example='64039198' — HS (customs tariff) code.
      - `value` **(required)**: number example=169 — Product value.
      - `quantity` **(required)**: integer example=1 — Product quantity.
      - `countryOfOrigin` **(required)**: string example='cz' — Country of origin — lowercase ISO 3166-1 alpha-2 code (e.g. `cz`); must be a known country.
  - `fees`: array — Additional invoice lines (shipping, discount, etc.).
    - `[item]`: object
      - `type` **(required)**: string enum=shipping,discount,other example='shipping' — Fee type.
      - `description` **(required)**: string example='Shipping cost' — Fee description.
      - `value` **(required)**: number example=10 — Fee value.

**Response 200** — Label created.

- `packages`: array
  - `[item]`: object
    - `id`: string example='1003201' — Package unique identification code.
    - `tracking`: string|null example='40050000000' — Package tracking code generated by the carrier.
- `label`: string example='JVBERi0xLjQKJe...' — Base64-encoded PDF of the label.
- `_links`: object
  - `self`: object
    - `href`: string example='/api/joy/shipments?id=A1234EDQS11A1' — URL of the resource.

**Response 400** — Validation error. `message` describes the problem and `id` names the offending field.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

```json
{
 "status": "error",
 "message": "Missing field: name",
 "id": "name"
}
```

**Response 401** — Missing or invalid authentication token.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

```json
{
 "status": "error",
 "message": "Token expired. Login via POST /login"
}
```

**Response 404** — Referenced product not found (`Product with id X not found, please create it via POST /products`).

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

**Response 409** — A shipment with this `id` already exists — use the update flow instead (`Resource already exists, use PUT method`).

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).


---
## GET `/shipments` — Print an existing label

Reprints the label of an existing shipment. A label cannot be printed more than 5 days after creation.

**Parameters**

- `id` (query) **required**: string  — Unique order identification code.
- `labelOrientation` (query): string enum=['L', 'P'] — Preferred label orientation — `P` (portrait) or `L` (landscape). Defaults to the carrier setting.

**Response 200** — Returns the tracking codes and the base64 PDF label.

- `packages`: array
  - `[item]`: object
    - `id`: string example='1003201' — Package unique identification code.
    - `tracking`: string|null example='40050000000' — Package tracking code generated by the carrier.
- `label`: string example='JVBERi0xLjQKJe...' — Base64-encoded PDF of the label.
- `_links`: object
  - `self`: object
    - `href`: string example='/api/joy/shipments?id=A1234EDQS11A1' — URL of the resource.

**Response 400** — Invalid label orientation, or the order is older than 5 days, or the printing service is unavailable.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

**Response 401** — Missing or invalid authentication token.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

```json
{
 "status": "error",
 "message": "Token expired. Login via POST /login"
}
```

**Response 404** — Shipment not found (`Package not found.`).

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).


---
## DELETE `/shipments` — Reject a shipment

Soft-rejects a shipment. Only shipments in the `printed` state can be rejected.

**Parameters**

- `id` (query) **required**: string  — Unique order identification code.

**Response 204** — Shipment rejected (empty body).

**Response 401** — Missing or invalid authentication token.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

```json
{
 "status": "error",
 "message": "Token expired. Login via POST /login"
}
```

**Response 404** — Shipment not found.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

**Response 409** — Shipment is not in the `printed` state (`Order has not Printed status`).

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).


---
## GET `/shipment` — Get shipment information

Returns shipment details together with tracking numbers, tracking links, order items and tracking events.

**Parameters**

- `id` (query) **required**: string  — Unique order identification code.

**Response 200** — Shipment detail.

- `id`: string example='AB123456' — Unique order identification code.
- `status`: string enum=pending,confirmed,sent,delivered,returned,rejected,undefined example='pending' — Order status code.
- `parcelService`: string example='pplcz'
- `name`: string example='Oskar Šnajdr'
- `street`: string example='Hlavná 23'
- `city`: string example='Horní Jasenka'
- `zip`: string example='75501'
- `country`: string example='cz'
- `email`: string email example='example@example.com'
- `phone`: string example='+421901000000'
- `variableSymbol`: string example='12345'
- `cod`: number example=250 — Cash on delivery.
- `_embedded`: object — Present keys only when non-empty (an empty `_embedded` is serialized as `[]`).
  - `trackingNumber`: array example=['40050587805']
    - `[item]`: string
  - `trackingLink`: array example=['https://www.speedy.bg/en/track-shipment?shipmentNumber=61878361874'] — Carrier tracking links (present only when the carrier provides them).
    - `[item]`: string
  - `items`: array — Order items.
    - `[item]`: object
      - `id`: string — Stock item external code.
      - `qty`: integer — Ordered quantity.
  - `trackingEvents`: array
    - `[item]`: object
      - `date`: string example='2018-09-01 12:45:15'
      - `message`: string example='Package in transit'

**Response 401** — Missing or invalid authentication token.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

```json
{
 "status": "error",
 "message": "Token expired. Login via POST /login"
}
```

**Response 404** — Shipment not found (`Shipment not found.`).

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).


---
## GET `/labels` — Print labels (bulk or single)

Returns a base64-encoded A6 PDF containing the requested labels.

Provide **either** `ids` (comma-separated, up to 100 order codes) for a combined
multi-label PDF, **or** `id` for a single order's label.

**Parameters**

- `ids` (query): string  — Comma-separated list of order identification codes (max 100). Used for the bulk variant.
- `id` (query): string  — Single order identification code. Used for the single-label variant.

**Response 200** — Base64-encoded PDF of the requested label(s).

- `labels`: string example='JVBERi0xLjQKJe...' — Base64-encoded A6 PDF containing the requested label(s).

**Response 400** — `ids` missing for the bulk variant, or more than 100 ids supplied (`Maximum number of labels is 100.`).

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

**Response 401** — Missing or invalid authentication token.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

```json
{
 "status": "error",
 "message": "Token expired. Login via POST /login"
}
```

**Response 404** — Order not found (single-label variant, `Not found.`).

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).


---
## POST `/packages` — Create a package (asynchronous flow)

Creates an order/package without immediately printing a label (the label is fetched later
via `GET /labels`). Returns a link to the created resource. The `id` is supplied in the body.

**Request body** (application/json)

-  (allOf):
    Common package fields for create/update. Note the ZIP field is named `psc` here (unlike `/shipments`, which uses `zip`).
  - `id`: string maxLength=30 example='1003201' — Unique order identification code. Required in the body on **create** (POST); on **update** (PUT) it is taken from the `id` query parameter and any body value is ignored.
  - `parcelService`: string example='joy' — Preferred parcel service (default `joy`).
  - `name` **(required)**: string maxLength=100 minLength=3 example='Oskar Šnajdr' — Recipient name (3-100 characters).
  - `street` **(required)**: string maxLength=255 minLength=3 example='Hlavná 23' — Recipient street (3-255 characters).
  - `city` **(required)**: string maxLength=50 minLength=2 example='Horní Jasenka' — Recipient city (2-50 characters).
  - `psc` **(required)**: string maxLength=10 minLength=3 example='75501' — Recipient ZIP code (3-10 characters).
  - `country` **(required)**: string example='cz' — Recipient country code (ISO 3166-1 alpha-2; must be a known country).
  - `email` **(required)**: string email maxLength=50 example='example@example.com'
  - `phone` **(required)**: string maxLength=20 minLength=6 example='+421901000000' — Recipient phone in international format (6-20 characters).
  - `variableSymbol` **(required)**: string maxLength=40 example='12345'
  - `cod`: number example=250 — Cash on delivery (default 0).
  - `note`: string maxLength=250 — Order note.
  - `invoiceLink`: string uri maxLength=255 — URL of the order invoice.
  - `numberOfPackages`: integer example=1 — Number of packages (default 1).
  - `deliveryPoint`: string example='12451' — Delivery point code.
  - `weight`: array example=[1.45] — Weight of each package. If supplied, its length must equal `numberOfPackages`.
    - `[item]`: number
  - `_embedded`: object
    - `notifyLinks`: array
      - `[item]`: object — Webhook URLs called on shipment status changes.
        - `confirmed`: string uri maxLength=255 example='http://example.com/order/1003201/confirmed' — Called when the package is confirmed.
        - `sent`: string uri maxLength=255 example='http://example.com/order/1003201/sent' — Called when the package is sent.
        - `delivered`: string uri maxLength=255 example='http://example.com/order/1003201/delivered' — Called when the package is delivered.
        - `returned`: string uri maxLength=255 example='http://example.com/order/1003201/returned' — Called when the package is returned.

**Response 201** — Package created.

  HAL response containing only a self link to the affected resource.
- `_links`: object
  - `self`: object
    - `href`: string example='/api/joy/packages?id=1003201' — URL of the resource.

**Response 400** — Validation error. `message` describes the problem and `id` names the offending field.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

```json
{
 "status": "error",
 "message": "Missing field: name",
 "id": "name"
}
```

**Response 401** — Missing or invalid authentication token.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

```json
{
 "status": "error",
 "message": "Token expired. Login via POST /login"
}
```

**Response 404** — Referenced product not found.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

**Response 409** — A package with this `id` already exists (`Resource already exists, use PUT method`).

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).


---
## PUT `/packages` — Update a package

Updates an existing package. Only packages in the `imported` (pending) state can be updated. The `id` is taken from the query parameter.

**Parameters**

- `id` (query) **required**: string  — Unique order identification code.

**Request body** (application/json)

  Common package fields for create/update. Note the ZIP field is named `psc` here (unlike `/shipments`, which uses `zip`).
- `id`: string maxLength=30 example='1003201' — Unique order identification code. Required in the body on **create** (POST); on **update** (PUT) it is taken from the `id` query parameter and any body value is ignored.
- `parcelService`: string example='joy' — Preferred parcel service (default `joy`).
- `name` **(required)**: string maxLength=100 minLength=3 example='Oskar Šnajdr' — Recipient name (3-100 characters).
- `street` **(required)**: string maxLength=255 minLength=3 example='Hlavná 23' — Recipient street (3-255 characters).
- `city` **(required)**: string maxLength=50 minLength=2 example='Horní Jasenka' — Recipient city (2-50 characters).
- `psc` **(required)**: string maxLength=10 minLength=3 example='75501' — Recipient ZIP code (3-10 characters).
- `country` **(required)**: string example='cz' — Recipient country code (ISO 3166-1 alpha-2; must be a known country).
- `email` **(required)**: string email maxLength=50 example='example@example.com'
- `phone` **(required)**: string maxLength=20 minLength=6 example='+421901000000' — Recipient phone in international format (6-20 characters).
- `variableSymbol` **(required)**: string maxLength=40 example='12345'
- `cod`: number example=250 — Cash on delivery (default 0).
- `note`: string maxLength=250 — Order note.
- `invoiceLink`: string uri maxLength=255 — URL of the order invoice.
- `numberOfPackages`: integer example=1 — Number of packages (default 1).
- `deliveryPoint`: string example='12451' — Delivery point code.
- `weight`: array example=[1.45] — Weight of each package. If supplied, its length must equal `numberOfPackages`.
  - `[item]`: number
- `_embedded`: object
  - `notifyLinks`: array
    - `[item]`: object — Webhook URLs called on shipment status changes.
      - `confirmed`: string uri maxLength=255 example='http://example.com/order/1003201/confirmed' — Called when the package is confirmed.
      - `sent`: string uri maxLength=255 example='http://example.com/order/1003201/sent' — Called when the package is sent.
      - `delivered`: string uri maxLength=255 example='http://example.com/order/1003201/delivered' — Called when the package is delivered.
      - `returned`: string uri maxLength=255 example='http://example.com/order/1003201/returned' — Called when the package is returned.

**Response 200** — Package updated.

  HAL response containing only a self link to the affected resource.
- `_links`: object
  - `self`: object
    - `href`: string example='/api/joy/packages?id=1003201' — URL of the resource.

**Response 400** — Validation error. `message` describes the problem and `id` names the offending field.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

```json
{
 "status": "error",
 "message": "Missing field: name",
 "id": "name"
}
```

**Response 401** — Missing or invalid authentication token.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

```json
{
 "status": "error",
 "message": "Token expired. Login via POST /login"
}
```

**Response 404** — Package not found (`Package not found. Create it via POST /packages`).

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

**Response 409** — Package is not in the pending state (`Package has not Pending status`).

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).


---
## GET `/packages` — Get package information

**Parameters**

- `id` (query) **required**: string  — Unique order identification code.

**Response 200** — Package detail.

- `id`: string example='AB123456'
- `status`: string enum=pending,confirmed,sent,delivered,returned,rejected,undefined example='pending'
- `parcelService`: string example='joy'
- `name`: string example='Oskar Šnajdr'
- `street`: string example='Hlavná 23'
- `city`: string example='Horní Jasenka'
- `psc`: string example='75501'
- `country`: string example='cz'
- `email`: string email example='example@example.com'
- `phone`: string example='+421901000000'
- `variableSymbol`: string example='12345'
- `cod`: number example=250
- `barcode`: string example='A1234EDQS11A1' — Order barcode (`uid`).
- `_embedded`: object — Present keys only when non-empty (an empty `_embedded` is serialized as `[]`).
  - `trackingNumber`: array example=['40050587805']
    - `[item]`: string
  - `items`: array
    - `[item]`: object
      - `id`: string — Stock item external code.
      - `qty`: integer — Ordered quantity.
  - `trackingEvents`: array — Up to 20 most recent tracking events.
    - `[item]`: object
      - `date`: string example='2018-09-01 12:45:15'
      - `message`: string example='Package in transit'

**Response 401** — Missing or invalid authentication token.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

```json
{
 "status": "error",
 "message": "Token expired. Login via POST /login"
}
```

**Response 404** — Package not found (`Package not found.`).

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).


---
## DELETE `/packages` — Delete a package

Deletes a package. Only packages in the `imported` (pending) state can be deleted.

**Parameters**

- `id` (query) **required**: string  — Unique order identification code.

**Response 204** — Package deleted (empty body).

**Response 401** — Missing or invalid authentication token.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

```json
{
 "status": "error",
 "message": "Token expired. Login via POST /login"
}
```

**Response 404** — Package not found.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

**Response 409** — Package is not in the pending state (`Order has not Pending status`).

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).


---
## POST `/packing-list` — Create a packing list

**Request body** (application/json)

- `code` **(required)**: string example='1003201' — Your internal packing list identification code.
- `expected_delivery_date` **(required)**: string date example='2023-01-15' — Expected delivery date (`Y-m-d`).
- `items` **(required)**: array example=['23012345', '23012346'] — Non-empty list of order ids. Each order must exist and must not already belong to a packing list.
  - `[item]`: string
- `label_orientation`: string enum=L,P — Preferred label orientation — `P` (portrait) or `L` (landscape).

**Response 200** — Packing list created.

- `id`: string example='J9VZIXSAL8' — Packing list identification code, printed on the label (the internal code).
- `code`: string example='1003201' — Your internal packing list code (the one supplied as `code` on create).
- `expected_delivery_date`: string date example='2023-01-15'
- `count`: integer example=2 — Packages count.
- `items`: array example=['23012345', '23012346']
  - `[item]`: string
- `label`: string example='JVBERi0xLjQKJeLjz..' — Base64-encoded PDF of the packing list label.

**Response 400** — Validation error. `message` describes the problem and `id` names the offending field.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

```json
{
 "status": "error",
 "message": "Missing field: name",
 "id": "name"
}
```

**Response 401** — Missing or invalid authentication token.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

```json
{
 "status": "error",
 "message": "Token expired. Login via POST /login"
}
```


---
## GET `/packing-list` — Get packing list detail

Returns a packing list and its base64 label. Optionally accepts `label_orientation` (`L`/`P`)
in the JSON body to rotate the label. Note: an invalid `label_orientation` here is not handled
as a clean `400` (unlike on create) and may surface as a server error.

**Parameters**

- `id` (query) **required**: string  — Your internal packing list code (`external_code`).

**Response 200** — Packing list detail.

- `id`: string example='J9VZIXSAL8' — Packing list identification code, printed on the label (the internal code).
- `code`: string example='1003201' — Your internal packing list code (the one supplied as `code` on create).
- `expected_delivery_date`: string date example='2023-01-15'
- `count`: integer example=2 — Packages count.
- `items`: array example=['23012345', '23012346']
  - `[item]`: string
- `label`: string example='JVBERi0xLjQKJeLjz..' — Base64-encoded PDF of the packing list label.

**Response 400** — Validation error. `message` describes the problem and `id` names the offending field.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

```json
{
 "status": "error",
 "message": "Missing field: name",
 "id": "name"
}
```

**Response 401** — Missing or invalid authentication token.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

```json
{
 "status": "error",
 "message": "Token expired. Login via POST /login"
}
```

**Response 404** — Packing list not found (`Packing list not found`).

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).


---
## DELETE `/packing-list` — Delete a packing list

Deletes a packing list. Only lists in the `created` state can be deleted.

**Parameters**

- `id` (query) **required**: string  — Your internal packing list code (`external_code`).

**Response 200** — Packing list deleted.

- `status` **(required)**: string example='ok'

**Response 401** — Missing or invalid authentication token.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

```json
{
 "status": "error",
 "message": "Token expired. Login via POST /login"
}
```

**Response 404** — Packing list not found.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

**Response 409** — Packing list cannot be modified in its current state (`Packing list can not be modified`).

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).


---
## POST `/packing-list-item` — Add an order to a packing list

Adds an order to a packing list. Both `id` and `order` are supplied in the body.

**Request body** (application/json)

- `id` **(required)**: string — Your internal packing list code (`external_code`).
- `order` **(required)**: string — Order identification code (`api_id`).

**Response 200** — Item added.

- `status` **(required)**: string example='ok'

**Response 400** — Validation error. `message` describes the problem and `id` names the offending field.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

```json
{
 "status": "error",
 "message": "Missing field: name",
 "id": "name"
}
```

**Response 401** — Missing or invalid authentication token.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

```json
{
 "status": "error",
 "message": "Token expired. Login via POST /login"
}
```

**Response 404** — Packing list or order not found (`Packing list not found` / `Order not found`).

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

**Response 409** — The order is already in a packing list.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).


---
## DELETE `/packing-list-item` — Remove an order from a packing list

**Parameters**

- `id` (query) **required**: string  — Order identification code (`api_id`).

**Response 200** — Item removed.

- `status` **(required)**: string example='ok'

**Response 401** — Missing or invalid authentication token.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

```json
{
 "status": "error",
 "message": "Token expired. Login via POST /login"
}
```

**Response 404** — Packing list item not found (`Packing list item not found`).

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

**Response 409** — Parent packing list cannot be modified in its current state.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).


---
## GET `/delivery-point` — List available delivery points

Returns the active carrier pick-up points for the given parcel service.

**Parameters**

- `parcelService` (query) **required**: string  — Parcel service code (e.g. `dhl_parcel`, `pplcz`, `packeta`).

**Response 200** — List of delivery points (empty array when none match).

- `[item]`: object — Carrier pick-up point. Field types map directly to the `delivery_point` table; `latitude`/`longitude` are modeled as numbers (inferred — the table predates the in-repo migrations, so column types are not verified against a schema).
  - `code`: string example='KM10103842'
  - `name`: string example='Potraviny Lipa'
  - `street`: string example='Nám. M.R. Štefánika'
  - `city`: string example='Brezno'
  - `zip`: string example='97701'
  - `country`: string example='sk'
  - `latitude`: number example=48.656829
  - `longitude`: number example=19.491561

**Response 400** — Missing `parcelService` (`Missing field parcelService`).

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

**Response 401** — Missing or invalid authentication token.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

```json
{
 "status": "error",
 "message": "Token expired. Login via POST /login"
}
```


---
## PUT `/anonymization` — Anonymize an order (internal / GDPR)

**Internal / GDPR operation.** Irreversibly anonymizes the personal data of a *closed*
order. Intended for data-protection purposes rather than routine integration; use with care.

**Parameters**

- `id` (query) **required**: string  — Order identification code (`api_id`).

**Response 200** — Order anonymized.

  HAL response containing only a self link to the affected resource.
- `_links`: object
  - `self`: object
    - `href`: string example='/api/joy/packages?id=1003201' — URL of the resource.

**Response 401** — Missing or invalid authentication token.

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

```json
{
 "status": "error",
 "message": "Token expired. Login via POST /login"
}
```

**Response 404** — Order not found (`Package not found. Create it via POST /packages`).

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

**Response 409** — Order is not closed (`Package is not closed`).

- `status` **(required)**: string example='error'
- `message`: string — Human-readable error description.
- `id`: string — Name of the offending field (present on validation errors).

