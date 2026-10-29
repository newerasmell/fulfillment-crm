# Kika Api 3 — full API reference

_Auto-rendered from the vendor OpenAPI spec (raw file alongside). Servers: [{'url': 'https://api.fhb.sk/v3'}]_

We have 2 API environments - production environment and sandbox for integration developmen

| Environment | API URL                   |
|-------------|---------------------------|
| Production  | https://api.fhb.sk/v3     |
| Sandbox     | https://api-dev.fhb.sk/v3 |

### Change log

#### 2026-07-29

- Added new endpoint `GET /rma/list` returning shipments that came back from the carrier (undelivered, refused deliveries among them). Cancelled orders (storna) are not included. Items use the same structure as order responses.

- Order responses (`GET /order`, `GET /order/history`, `GET /rma/list`) now include `returned_at` (the return date, `null` when the order has not been returned) and `return_type` (`return` | `claim` | `write_off`).

- `GET /return/list` is unchanged and keeps returning "local" returns received at depots — it is an extra service that has to be activated by the sales department.

#### 2026-05-28

- Added multi-product (set/collection) support to product endpoints. `POST /product` and `PUT /product` now accept an optional `type` (`single`|`multi`) and an `items` array of components (each with `id` and `quantity`). Product responses (`GET /product`, `GET /product/all`, create/update) now include `type` and `items` (`null` for single products).

- A single product can be promoted to a multi-product via `PUT /product`; demoting a multi-product back to single is not supported (`DEMOTE_NOT_SUPPORTED`). Components must be existing, active single products — see the multi-product validation error codes (`MULTI_ITEMS_EMPTY`, `MULTI_ITEMS_ON_SINGLE`, `MULTI_ITEMS_DUPLICATE`, `MULTI_ITEM_NOT_FOUND`, `MULTI_ITEM_NESTED_MULTI`, `MULTI_ITEM_SELF_REFERENCE`, `MULTI_ITEM_IGNORED`, `CANNOT_PROMOTE_REFERENCED_PRODUCT`).

#### 2026-05-12

- Added new endpoints `GET /return/list`, `GET /return/{uid}`, and `GET /return/{uid}/photo/{photoId}` for reading "local" return packages received at depots.

#### 2026-04-29

- Order responses now include `sscc` (string|null, 18-digit EAN-128 code) and `packing_packages` (array of `{number, sscc}` objects) when SSCC labels have been issued for the order.

#### 2026-04-21

- Added new endpoints `GET /cod` and `GET /cod/list` for querying cash-on-delivery payment status (`waiting`, `received`, `paid`).

#### 2026-04-01

- Added `print_sscc` flag to order create/update/read endpoints. The default value is `false` when missing.

#### 2026-03-09

- Added `created_at`, `shipped_at`, and `delivered_at` date fields to all order response endpoints.

#### 2025-12-22

- Added `package_dimension` object to order package responses, containing dimensions (length, width, height) and calculated volumetric weight.

#### 2025-12-10

- Added `print_delivery_note` flag to order create/update/read endpoints. The default value is `false` when missing.

- Order responses now include `uid` alongside `id` for GET/POST/PUT order endpoints.

- Added `volumetric_weight` field to single product response (`GET /product?id=...`).

#### 2025-11-18

- Added `volumetric_weight` field to product list response (`GET /product/all`).
  The volumetric weight is now included in the product data for all API responses.

#### 2025-09-12

- Added new endpoint `PUT /order/invoice` for updating order invoice details (customs information).
  Only orders in statuses `new`, `imported`, `b2b_new`, `packed` can have invoice data modified.

#### 2025-09-29

- Reading order endpoint: Added alternative parameter `tracking`.
  Either `id` or `tracking` must be provided.

#### 2024-12-12

- Removed `note_delivery` from order


## Section: Authentication

Obtain and use access tokens. Every client has an `app_id` and `secret` (generated in the ZOE system, https://zoe2.fhb.sk).


## Section: Products

Manage the product catalogue used by fulfillment services.


## Section: Orders

## List of order statuses

- pending

- confirmed

- sent

- delivered

- rejected


## Section: Cash on delivery

Endpoints returning COD payment status.

Status values:

- `waiting` - order has COD set, payment has not yet been received from the courier

- `received` - COD has been received from the courier, but not yet paid out to the seller

- `paid` - COD has been paid out to the seller


## Section: RMA

Endpoints for reading returned shipments — orders that came back from the carrier.

- Includes undelivered shipments, refused deliveries among them. The two are **not** distinguished: a refused shipment comes back and ends up in the same state as any other undelivered one.

- Cancelled orders (storna) are **not** included.

- Items use the same structure as order responses, with `returned_at` (the return date) and `return_type` filled in.

- `returned_at` is `null` in the rare case where no return record was created for the order.


## Section: Returns

Endpoints for reading "local" return packages — return shipments physically received and processed at depots.

> **This is an extra service that has to be activated by the sales department.** Without it these endpoints return no data. Contact your sales representative to have it enabled.

Each return has:

- A unique `uid` (the scanned return code, e.g. `AB00001`)

- One or more scanned package `barcodes`

- A `type` of either `basic` (package-level tracking only) or `complex` (individual item tracking)

- A `status` indicating its current stage in the return workflow

- Zero or more `photos` (package exterior, package contents, accompanying documents)

- Zero or more `items` (populated only when `type` is `complex`)


## Section: Parcel services

List available carriers and their delivery points.


## Section: Stock management

Stock receipts, stock levels and stock movements.


## Section: Validations and error messages

Every invalid create and update request returns 400 Bad Request response with list of invalid fields and values.

#### Structure of 400 Bad Request response

```
{
    "message": "Invalid request",
    "violations": {
        "items": [
            {
                "code": "TOO_FEW_ERROR",
                "message": "This collection should contain 1 element or more."
            }
        ],
        "variable_symbol": [
            {
                "code": "IS_BLANK_ERROR",
                "message": "This value should not be blank."
            }
        ],
        "value": [
            {
                "code": "IS_BLANK_ERROR",
                "message": "This value should not be blank."
            }
        ],
        "recipient.address.name": [
            {
                "code": "IS_BLANK_ERROR",
                "message": "This value should not be blank."
            }
        ],
        "recipient.address.street": [
            {
                "code": "IS_BLANK_ERROR",
                "message": "This value should not be blank."
            }
        ],
        "recipient.address.city": [
            {
                "code": "IS_BLANK_ERROR",
                "message": "This value should not be blank."
            }
        ],
        "recipient.address.zip": [
            {
                "code": "IS_BLANK_ERROR",
                "message": "This value should not be blank."
            }
        ],
        "recipient.address.country": [
            {
                "code": "IS_BLANK_ERROR",
                "message": "This value should not be blank."
            }
        ],
        "recipient.contact": [
            {
                "code": "IS_BLANK_ERROR",
                "message": "This value should not be blank."
            }
        ]
    }
}
```


## Section: Notifications

<a name="stock-level-notifications"></a>

## Stock level notification

Stock level update notification is triggered every time when product stock level was changed.

You can set up stock level notification by defining `notify_url` in product request.

Notification URL is called with POST method and request body is JSON with notification data.

###### Notification data

| Parameter         | Description                                 |
|-------------------|---------------------------------------------|
| `id`              | Product id                                  |
| `type`            | Type of the movement in/out                 |
| `qty`             | Quantity                                    |
| `stockQuantity`   | Current stock balance                       |
| `reason`          | Reason code, see list of reason codes below |
| `serialNumbers[]` | Serial number list

###### Reason codes

| Reason code | Description    |
|-------------|----------------|
| `1`         | Manual change  |
| `2`         | Sent order     |
| `3`         | Receipt        |
| `4`         | Returned order |
| `5`         | Canceled order |

**Auth `AuthSimple`:** {"type": "apiKey", "in": "header", "name": "X-Authentication-Simple", "description": "Base64-encoded access token. Obtain a token via `POST /login`, then send it on every request as `X-Authentication-Simple: base64(token)`. Tokens expire \u2014 re-login when they do."}


---
## POST `/login` — Login

**Request body** (application/json)

- `app_id` **(required)**: string
- `secret` **(required)**: string

**Response 200** — OK

- `token`: string — Access token
- `expiration`: string — Date and time of token expiration

```json
{
 "response": {
  "token": "f7165ad327942721750f6b113d7bea9017957671khd1nvx2uc233adt1298",
  "expiration": "2018-10-17T14:47:40+0200"
 }
}
```

**Response 400** — Bad Request

- `message` **(required)**: string
- `violations`: object

```json
{
 "invalidCredentials": {
  "message": "Invalid AppId or secret"
 },
 "validationError": {
  "message": "Invalid request",
  "violations": {
   "app_id": [
    {
     "code": "IS_BLANK_ERROR",
     "message": "This value should not be blank."
    }
   ],
   "secret": [
    {
     "code": "IS_BLANK_ERROR",
     "message": "This value should not be blank."
    }
   ]
  }
 }
}
```


---
## POST `/product` — Create new product

Allows to create the new product. Returns information about new product.

Supports both regular single products and multi-products (sets/collections). When `type` is `multi`, the
non-empty `items` array of components is required. Multi-products cannot contain other multi-products
and cannot reference themselves.

Multi-product validation errors (`400`):

- `MULTI_ITEMS_EMPTY` — `type` is `multi` but `items` is empty.

- `MULTI_ITEMS_ON_SINGLE` — `items` provided for a single product.

- `MULTI_ITEMS_DUPLICATE` — the same component is listed more than once.

- `MULTI_ITEM_NOT_FOUND` — a referenced component does not exist (archived products are treated as non-existent and also report this code).

- `MULTI_ITEM_NESTED_MULTI` — a referenced component is itself a multi-product.

- `MULTI_ITEM_SELF_REFERENCE` — a component refers to the product itself.

- `MULTI_ITEM_IGNORED` — a referenced component is an ignored product (ignored products are skipped during order fulfillment and cannot be components).

- `CANNOT_PROMOTE_REFERENCED_PRODUCT` — the product is already a component of another multi-product and cannot be promoted to `multi`.

**Request body** (application/json)

- `id` **(required)**: string — Unique product ID (products are paired on this value, it must be an unique ID for each product, and does not change over time) Beware of characters: #, &, %, etc.
- `name` **(required)**: string — Name of the product (maximum 150 characters)
- `ean`: string — EAN-13  ATTENTION! This value can be changed to fit the real EAN on the product. Please customize your integration so that you do not overwrite this value with invalid values from your system!
- `photo`: string maxLength=255 — URL to an image of the product (maximum 255 characters)
- `notify_url`: string maxLength=255 — Callback URL which is called on stock movement of this product. [More info about product notifications](#stock-level-notifications)
- `serial_numbers`: boolean — Serial number tracking. Allows to track which stock unit was packed and delivered to a particular customer.
- `type`: string enum=single,multi — Product type. Defaults to `single`. Use `multi` to create a product set.
- `items`: array — Components for multi-products. Required and non-empty when `type` is `multi`. Each item must reference an existing, active single product (archived and ignored products cannot be components).
  - `[item]`: object
    - `id` **(required)**: string — Component product ID
    - `quantity` **(required)**: integer — Number of component pieces in the multi-product
- `customs_information`: object
  - `hs_code`: string maxLength=255 — HS code
  - `country_of_origin`: string — ISO country code
  - `purchase_price`: number — Purchase price

**Response 200** — OK

- `id`: string — Unique product ID
- `internal_code`: string — Internal product code
- `ean`: string|null — EAN-13
- `name`: string|null — Name of the product
- `photo`: string|null — URL to an image of the product
- `weight`: number|null — Product weight
- `volumetric_weight`: number|null — Volumetric weight (type 2)
- `notify_url`: string|null — Callback URL which is called on stock movement of this product. [More info about product notifications](#stock-level-notifications)
- `archived`: boolean
- `stock_quantity`: integer — Numer of pieces on the stock
- `free_quantity`: integer — Total number of pieces, which will remain on the stock after all orders are complete
- `serial_numbers`: boolean — Serial number tracking. Indicates whether stock units of this product are tracked by serial number.
- `type`: string enum=single,multi — Product type (`single` or `multi`)
- `items`: array|null — For multi-products: list of components. `null` for single products.
  - `[item]`: object
    - `id` **(required)**: string — Component product ID
    - `name`: string|null — Component product name
    - `quantity` **(required)**: integer — Number of component pieces in the multi-product
- `customs_information`: object
  - `hs_code`: string — HS code
  - `country_of_origin`: string — ISO country code
  - `purchase_price`: number — Purchase price

```json
{
 "response": {
  "id": "123",
  "internal_code": "ABC1234",
  "ean": "8580000001234",
  "name": "Shampoo",
  "photo": "http://example.com/image.png",
  "weight": 0,
  "volumetric_weight": 0.5,
  "notify_url": "http://example.com/api/product/123/notify",
  "archived": false,
  "stock_quantity": 0,
  "free_quantity": 0,
  "serial_numbers": false,
  "type": "single",
  "items": [
   {
    "id": "ABC456",
    "name": "Component name",
    "quantity": 2
   }
  ],
  "customs_information": {
   "hs_code": "390110",
   "country_of_origin": "SK",
   "purchase_price": 12.34
  }
 }
}
```

**Response 400** — Bad Request

- `message`: string
- `violations`: object
  - `items[0].id`: array
    - `[item]`: object
      - `code`: string
      - `message`: string

```json
{
 "response": {
  "message": "Invalid request",
  "violations": {
   "items[0].id": [
    {
     "code": "MULTI_ITEM_NOT_FOUND",
     "message": "Item \"MISSING\" does not exist."
    }
   ]
  }
 }
}
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```

**Response 404** — Not Found

- `message`: string

```json
{
 "message": "Product 123 not found"
}
```


---
## PUT `/product` — Update existing product

Allows to edit the product. Returns information about changed product. If you want to change product ID, add `new_id` property to request. Value of `new_id` must be unique.

Supports multi-product operations:

- Omitting `type` and `items` preserves the existing product type and components.

- Sending `type=multi` with `items` on an existing single product promotes it to a multi-product (internal code, stock quantity, and stock movements are preserved).

- Sending `items` on an existing multi-product replaces its components (replace-all semantics).

- Demoting a multi-product to single (`type=single` on a multi-product) is **not supported** (`DEMOTE_NOT_SUPPORTED`).

**Parameters**

- `id` (query) **required**: string  — An unique identifier of the product.

**Request body** (application/json)

- `new_id`: string — New product id. Use only when product id was changed.
- `name` **(required)**: string — Name of the product (maximum 150 characters)
- `ean`: string — EAN-13     ATTENTION! This value can be changed to fit the real EAN on the product. Please customize your integration so that you do not overwrite this value with invalid values from your system!
- `photo`: string maxLength=255 — URL to an image of the product (maximum 255 characters)
- `notify_url`: string maxLength=255 — Callback URL which is called on stock movement of this product. [More info about product notifications](#stock-level-notifications)
- `serial_numbers`: boolean — Serial number tracking. Allows to track which stock unit was packed and delivered to a particular customer.
- `type`: string enum=single,multi — Target product type. Omit to preserve current type. Use `multi` to create/keep a multi-product or promote a single product to multi. Demoting from `multi` to `single` is not supported.
- `items`: array — Components for multi-products. Replace-all semantics. Required non-empty when promoting a single to multi.
  - `[item]`: object
    - `id` **(required)**: string — Component product ID
    - `quantity` **(required)**: integer — Number of component pieces in the multi-product
- `customs_information`: object
  - `hs_code`: string maxLength=255 — HS code
  - `country_of_origin`: string — ISO country code
  - `purchase_price`: number — Purchase price

**Response 200** — OK

- `id`: string — Unique product ID
- `internal_code`: string — Internal product code
- `ean`: string|null — EAN-13
- `name`: string|null — Name of the product
- `photo`: string|null — URL to an image of the product
- `weight`: number|null — Product weight
- `volumetric_weight`: number|null — Volumetric weight (type 2)
- `notify_url`: string|null — Callback URL which is called on stock movement of this product. [More info about product notifications](#stock-level-notifications)
- `archived`: boolean
- `stock_quantity`: integer — Numer of pieces on the stock
- `free_quantity`: integer — Total number of pieces, which will remain on the stock after all orders are complete
- `serial_numbers`: boolean — Serial number tracking. Indicates whether stock units of this product are tracked by serial number.
- `type`: string enum=single,multi — Product type (`single` or `multi`)
- `items`: array|null — For multi-products: list of components. `null` for single products.
  - `[item]`: object
    - `id` **(required)**: string — Component product ID
    - `name`: string|null — Component product name
    - `quantity` **(required)**: integer — Number of component pieces in the multi-product
- `customs_information`: object
  - `hs_code`: string — HS code
  - `country_of_origin`: string — ISO country code
  - `purchase_price`: number — Purchase price

```json
{
 "response": {
  "id": "123",
  "internal_code": "ABC1234",
  "ean": "8580000001234",
  "name": "Shampoo",
  "photo": "http://example.com/image.png",
  "weight": 0,
  "volumetric_weight": 0.5,
  "notify_url": "http://example.com/api/product/123/notify",
  "archived": false,
  "stock_quantity": 0,
  "free_quantity": 0,
  "serial_numbers": false,
  "type": "single",
  "items": [
   {
    "id": "ABC456",
    "name": "Component name",
    "quantity": 2
   }
  ],
  "customs_information": {
   "hs_code": "390110",
   "country_of_origin": "SK",
   "purchase_price": 12.34
  }
 }
}
```

**Response 400** — Bad Request

- `message`: string
- `violations`: object

```json
{
 "demoteNotSupported": {
  "message": "Invalid request",
  "violations": {
   "type": [
    {
     "code": "DEMOTE_NOT_SUPPORTED",
     "message": "Demoting a multi-product to single is not supported."
    }
   ]
  }
 },
 "notUniqueProduct": {
  "message": "Invalid request",
  "violations": {
   "new_id": [
    {
     "code": "NOT_UNIQUE_PRODUCT_ERROR",
     "message": "Product with this id already exists."
    }
   ]
  }
 },
 "cannotPromoteReferenced": {
  "message": "Invalid request",
  "violations": {
   "type": [
    {
     "code": "CANNOT_PROMOTE_REFERENCED_PRODUCT",
     "message": "Product is already a component of another multi-product and cannot be promoted."
    }
   ]
  }
 }
}
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```

**Response 404** — Not Found

- `message`: string

```json
{
 "message": "Product 123 not found"
}
```


---
## GET `/product` — Read product

**Parameters**

- `id` (query) **required**: string  — An unique identifier of the product.

**Response 200** — Product detail.

- `id`: string — Unique product ID
- `internal_code`: string — Internal product code
- `ean`: string|null — EAN-13
- `name`: string|null — Name of the product
- `photo`: string|null — URL to an image of the product
- `weight`: number|null — Product weight
- `volumetric_weight`: number|null — Volumetric weight (type 2)
- `notify_url`: string|null — Callback URL which is called on stock movement of this product. [More info about product notifications](#stock-level-notifications)
- `archived`: boolean
- `stock_quantity`: integer — Numer of pieces on the stock
- `free_quantity`: integer — Total number of pieces, which will remain on the stock after all orders are complete
- `serial_numbers`: boolean — Serial number tracking. Indicates whether stock units of this product are tracked by serial number.
- `type`: string enum=single,multi — Product type (`single` or `multi`)
- `items`: array|null — For multi-products: list of components. `null` for single products.
  - `[item]`: object
    - `id` **(required)**: string — Component product ID
    - `name`: string|null — Component product name
    - `quantity` **(required)**: integer — Number of component pieces in the multi-product
- `customs_information`: object
  - `hs_code`: string — HS code
  - `country_of_origin`: string — ISO country code
  - `purchase_price`: number — Purchase price

```json
{
 "response": {
  "id": "123",
  "internal_code": "ABC1234",
  "ean": "8580000001234",
  "name": "Shampoo",
  "photo": "http://example.com/image.png",
  "weight": 0,
  "volumetric_weight": 0.5,
  "notify_url": "http://example.com/api/product/123/notify",
  "archived": false,
  "stock_quantity": 0,
  "free_quantity": 0,
  "serial_numbers": false,
  "type": "single",
  "items": [
   {
    "id": "ABC456",
    "name": "Component name",
    "quantity": 2
   }
  ],
  "customs_information": {
   "hs_code": "390110",
   "country_of_origin": "SK",
   "purchase_price": 12.34
  }
 }
}
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```

**Response 404** — Not Found

- `message`: string

```json
{
 "message": "Product 123 not found"
}
```


---
## GET `/product/all` — List products

Allows to show all products in the database, returns informations about the product and its balance in stock. Limit 250 products on the page.

**Parameters**

- `page` (query): number  — Page number

**Response 200** — OK

- `page`: number — Page number
- `total`: number — Total product count
- `products`: array
  - `[item]`: object
    - `id`: string — Unique product ID
    - `internal_code`: string — Internal product code
    - `ean`: string|null — EAN-13
    - `name`: string|null — Name of the product
    - `photo`: string|null — URL to an image of the product
    - `weight`: number|null — Product weight
    - `volumetric_weight`: number|null — Volumetric weight (type 2)
    - `notify_url`: string|null — Callback URL which is called on stock movement of this product. [More info about product notifications](#stock-level-notifications)
    - `archived`: boolean
    - `stock_quantity`: integer — Numer of pieces on the stock
    - `free_quantity`: integer — Total number of pieces, which will remain on the stock after all orders are complete
    - `serial_numbers`: boolean — Serial number tracking. Indicates whether stock units of this product are tracked by serial number.
    - `type`: string enum=single,multi — Product type (`single` or `multi`)
    - `items`: array|null — For multi-products: list of components. `null` for single products.
      - `[item]`: object
        - `id` **(required)**: string — Component product ID
        - `name`: string|null — Component product name
        - `quantity` **(required)**: integer — Number of component pieces in the multi-product
    - `customs_information`: object
      - `hs_code`: string — HS code
      - `country_of_origin`: string — ISO country code
      - `purchase_price`: number — Purchase price

```json
{
 "response": {
  "page": 1,
  "total": 245,
  "products": [
   {
    "id": "123",
    "internal_code": "ABC1234",
    "ean": "8580000001234",
    "name": "Shampoo",
    "photo": "http://example.com/image.png",
    "weight": 0.32,
    "volumetric_weight": 0.5,
    "notify_url": "http://example.com/api/product/123/notify",
    "archived": false,
    "stock_quantity": 0,
    "free_quantity": 0,
    "serial_numbers": false,
    "type": "single",
    "items": [
     {
      "id": "ABC456",
      "name": "Component name",
      "quantity": 2
     }
    ],
    "customs_information": {
     "hs_code": "390110",
     "country_of_origin": "SK",
     "purchase_price": 12.34
    }
   }
  ]
 }
}
```

**Response 400** — Bad Request

- `message`: string

```json
{
 "message": "Invalid request"
}
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```


---
## GET `/product/archive` — Archive

**Parameters**

- `id` (query) **required**: string  — Product identification code

**Response 204** — No Content

**Response 400** — Bad Request

- `message`: string
- `violations`: object

```json
{
 "response": {
  "message": "Invalid request",
  "violations": {
   "id": [
    {
     "code": "NOT_EXISTING_PRODUCT_ERROR",
     "message": "Product does not exist."
    }
   ]
  }
 }
}
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```


---
## POST `/order` — Creating order

Creating new order that will be fulfilled.

**Request body** (application/json)

- `id` **(required)**: string — Unique order identification code
- `variable_symbol` **(required)**: string — Variable symbol, used for order identification. Must ne unique, number only value with max length of 10.
- `parcel_service`: string — Preferred parcel service code
- `delivery_point`: string maxLength=255 — Delivery point code, required for delivery to the delivery point
- `delivery_point_parameters`: object|null — Map of additional delivery point parameters. Conditionally required when the selected parcel service defines required delivery point parameters.
- `cod`: number — Cash on delivery amount - if not cash on delivery, skip this parameter, or set to 0. <b>WARNING! It must always be in local currency! If delivery address is in Czech Republic, COD must be in Czech koruna, etc.</b>
- `value`: number — Order value, used for insurance in LOCAL CURRENCY
- `sender`: string — Preferred sender code
- `validate`: boolean — Order address validation: If this parameter is set to true, in case of unsuccessful validation, the order will not be imported.
- `recipient` **(required)**: object
  - `address` **(required)**: object
    - `name` **(required)**: string — Name and surname of the recipient
    - `street` **(required)**: string — Delivery address
    - `city` **(required)**: string — Delivery city
    - `zip` **(required)**: string — Delivery postal code
    - `province`: string — Delivery province, if country has provinces
    - `country` **(required)**: string — Delivery country in `ISO 3166-1 alpha-2` format
  - `contact` **(required)**: object
    - `email` **(required)**: string maxLength=50 — Recipient's email
    - `phone` **(required)**: string maxLength=20 — Recipient's phone in INTERNATIONAL format
- `items` **(required)**: array
  - `[item]`: object
    - `id` **(required)**: string — Product ID
    - `quantity` **(required)**: integer minimum=1 — Ordered quantity
- `notification`: object
  - `confirmed`: string maxLength=255 — URL is called when the order is confirmed and enters packing process
  - `sent`: string maxLength=255 — URL is called when the order is sent
  - `delivered`: string maxLength=255 — URL is called when the order is completed
  - `returned`: string maxLength=255 — URL is called when order is delivered
  - `ticket_created`: string maxLength=255 — URL is called when ticket is created
  - `ticket_updated`: string maxLength=255 — URL is called when ticket is updated
  - `ticket_closed`: string maxLength=255 — URL is called when ticket is closed
- `invoice`: string maxLength=255 — Link to the pdf invoice file
- `invoice_number`: string maxLength=255 — Invoice number
- `invoice_date`: string — Invoice date
- `note`: string maxLength=250 — Order note (used for fulfillment centrum - is not sent to recipient)
- `print_delivery_note`: boolean — Set to true to request printing of the delivery note
- `print_sscc`: boolean — Set to true to request printing of the SSCC label
- invoice_detail (allOf):
  - `number` **(required)**: string maxLength=40 — Invoice number
  - `total` **(required)**: number — Total invoice amount
  - `currency` **(required)**: string maxLength=3 — Invoice currency
  - `date_of_issue` **(required)**: string date — Invoice date in YYYY-MM-DD format
  - `products`: array — Products on the invoice
    - `[item]`: object
      - `code` **(required)**: string maxLength=255 — Product code
      - `description` **(required)**: string — Product description
      - `hs_code` **(required)**: string maxLength=255 — HS (customs tariff) code
      - `value` **(required)**: number — Product value
      - `quantity` **(required)**: integer — Product quantity
      - `country_of_origin` **(required)**: string — Country of origin in `ISO 3166-1 alpha-2` format
  - `fees`: array — Additional invoice lines (shipping, discounts, etc.)
    - `[item]`: object
      - `type` **(required)**: string enum=shipping,other,discount — Fee type
      - `description` **(required)**: string — Fee description
      - `value` **(required)**: number — Fee value

**Response 200** — OK

- `id`: string — Unique order identification code
- `uid`: string — Internal order UID
- `variable_symbol`: string — Variable symbol
- `status`: string — Order status
- `created_at`: string — Order creation date
- `shipped_at`: string|null — Date when order was shipped
- `delivered_at`: string|null — Date when order was delivered
- `returned_at`: string|null — Date when the shipment was returned (`null` if the order has not been returned). Independent of `status`: `status` describes the order, `returned_at` and `return_type` describe the return record itself.
- `return_type`: string|null enum=return,claim,write_off — How the return was recorded - `return` (shipment came back from the carrier), `claim` (returned by the customer) or `write_off`. `null` if the order has not been returned. In practice almost always `return`.
- `parcel_service`: string — Preferred parcel service code
- `delivery_point`: string|null — Delivery point code (only if delivery to the delivery point)
- `cod`: number — Cash on delivery amount
- `value`: number — Order value
- `invoice`: string — Link to the pdf invoice file
- `invoice_number`: string — Invoice number
- `invoice_date`: string|null — Invoice date
- `note`: string — Order note (used for fulfillment centrum - is not sent to recipient)
- `print_delivery_note`: boolean — Delivery note print preference (`false` when not provided)
- `print_sscc`: boolean — SSCC label print preference (`false` when not provided)
- `sscc`: string|null — 18-digit order-level SSCC code, `null` if not yet issued
- `packing_packages`: array — Per packing-package SSCC codes, empty array if none
  - `[item]`: object
    - `number`: integer — Packing package number
    - `sscc`: string — 18-digit packing-package SSCC code
- `sender`: string|null — Preferred sender code
- `recipient`: object
  - `address`: object
    - `name`: string — Name and surname of the recipient
    - `street`: string — Delivery address
    - `city`: string — Delivery city
    - `zip`: string — Delivery postal code
    - `province`: string — Delivery province, if country has provinces
    - `country`: string — Delivery country in `ISO 3166-1 alpha-2` format
  - `contact` **(required)**: object
    - `email`: string maxLength=50 — Recipient's email
    - `phone`: string maxLength=20 — Recipient's phone in INTERNATIONAL format
- `notification`: object
  - `confirmed`: string — URL is called when the order is confirmed and enters packing process
  - `sent`: string — URL is called when the order is sent
  - `delivered`: string — URL is called when the order is completed
  - `returned`: string — URL is called when order is delivered
  - `ticket_created`: string — URL is called when ticket is created
  - `ticket_updated`: string — URL is called when ticket is updated
  - `ticket_closed`: string — URL is called when ticket is closed
- `tracking_numbers`: array — List of assigned tracking numbers
  - `[item]`: string
- `tracking_links`: array — List of tracking url (if available for selected delivery service)
  - `[item]`: string
- `items` **(required)**: array
  - `[item]`: object
    - `id` **(required)**: string — Product ID
    - `quantity` **(required)**: integer — Ordered quantity
    - `serial_numbers`: array — Serial numbers assigned to the ordered units
      - `[item]`: string
- `packages`: array — List of shipped packages
  - `[item]`: object
    - `tracking_number`: string|null — Package tracking number
    - `weight`: number — Package weight
    - `package_dimension`: object|null — Package dimensions and volumetric weight
      - `length`: number|null
      - `width`: number|null
      - `height`: number|null
      - `volumetric_weight`: number|null
- `attributes`: array — Order attributes exposed to the API
  - `[item]`: object
    - `key` **(required)**: string — Attribute key
    - `value` **(required)**: string — Attribute value
- `tracking_events`: array — List of tracking events
  - `[item]`: object
    - `date`: string — Event date
    - `message`: string — Event message
    - `event_code`: string|null — Internal event code
    - `carrier_event_code`: string|null — Carrier event code
- `package_returns`: array — List of return tracking numbers
  - `[item]`: object
    - `tracking`: string — Original package tracking number
    - `return_tracking`: string — Return tracking number
- `proof_of_delivery`: object — Name of the package recipient and the date of receipt. Only if parcel service provide these information
  - `recipient`: string — Name of the package recipient
  - `date`: string — Date of receipt
- invoice_detail (allOf):
  - `number` **(required)**: string maxLength=40 — Invoice number
  - `total` **(required)**: number — Total invoice amount
  - `currency` **(required)**: string maxLength=3 — Invoice currency
  - `date_of_issue` **(required)**: string date — Invoice date in YYYY-MM-DD format
  - `products`: array — Products on the invoice
    - `[item]`: object
      - `code` **(required)**: string maxLength=255 — Product code
      - `description` **(required)**: string — Product description
      - `hs_code` **(required)**: string maxLength=255 — HS (customs tariff) code
      - `value` **(required)**: number — Product value
      - `quantity` **(required)**: integer — Product quantity
      - `country_of_origin` **(required)**: string — Country of origin in `ISO 3166-1 alpha-2` format
  - `fees`: array — Additional invoice lines (shipping, discounts, etc.)
    - `[item]`: object
      - `type` **(required)**: string enum=shipping,other,discount — Fee type
      - `description` **(required)**: string — Fee description
      - `value` **(required)**: number — Fee value

```json
{
 "response": {
  "id": "AB12345",
  "uid": "3c7ac0f0ab",
  "variable_symbol": "12345",
  "status": "imported",
  "created_at": "2022-07-12T10:30:00+0100",
  "shipped_at": "2022-07-13T14:00:00+0100",
  "delivered_at": "2022-07-15T09:00:00+0100",
  "parcel_service": "remax",
  "delivery_point": "12345",
  "cod": 0,
  "value": 15.35,
  "invoice": "http://example.com/order/inv123.pdf",
  "invoice_number": "202207120001",
  "invoice_date": "2022-07-12",
  "note": "Order note",
  "print_delivery_note": false,
  "print_sscc": false,
  "sscc": "085860288700000423",
  "packing_packages": [
   {
    "number": 1,
    "sscc": "085860288700000567"
   }
  ],
  "sender": "SHOP_XY",
  "recipient": {
   "address": {
    "name": "Martin Novák",
    "street": "Hronská 35",
    "city": "Zvolen",
    "zip": "96001",
    "province": "",
    "country": "sk"
   },
   "contact": {
    "email": "email@example.com",
    "phone": "+421900123456"
   }
  },
  "items": [
   {
    "id": "12345",
    "quantity": 1
   }
  ],
  "notification": {
   "confirmed": "http://example.com/api/order/123/confirm",
   "sent": "http://example.com/api/order/123/sent",
   "delivered": "http://example.com/api/order/123/delivered",
   "returned": "http://example.com/api/order/123/returned",
   "ticket_created": "http://example.com/api/order/123/ticket/created",
   "ticket_updated": "http://example.com/api/order/123/ticket/updated",
   "ticket_closed": "http://example.com/api/order/123/ticket/closed"
  },
  "tracking_numbers": [],
  "tracking_links": [],
  "tracking_events": [],
  "proof_of_delivery": {
   "recipient": "Martin Novák",
   "date": "2018-11-06T09:11:20+0100"
  }
 }
}
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```


---
## PUT `/order` — Editing order

Rewrites order with that ID, it can be only if the order has pending status. Parameters are the same as for the POST method. Lines are edited in place, i.e. a product that stays in the request keeps its order line (and its stock reservation), products left out are removed, new products are appended. Lines are returned in creation order, so a kept line keeps its position and added products follow it.

**Parameters**

- `id` (query) **required**: string  — An unique identifier of the order.

**Request body** (application/json)

- `variable_symbol`: string — Variable symbol
- `parcel_service`: string — Preferred parcel service code
- `delivery_point`: string maxLength=255 — Delivery point code, required for delivery to the delivery point
- `delivery_point_parameters`: object|null — Map of additional delivery point parameters. Conditionally required when the selected parcel service defines required delivery point parameters.
- `cod`: number — Cash on delivery amount - if not cash on delivery, skip this parameter, or set to 0
- `value`: number — Order value, used for insurance
- `sender`: string — Preferred sender code
- `recipient` **(required)**: object
  - `address` **(required)**: object
    - `name` **(required)**: string — Name and surname of the recipient
    - `street` **(required)**: string — Delivery address
    - `city` **(required)**: string — Delivery city
    - `zip` **(required)**: string — Delivery postal code
    - `province`: string — Delivery province, if country has provinces
    - `country` **(required)**: string — Delivery country in `ISO 3166-1 alpha-2` format
  - `contact` **(required)**: object
    - `email` **(required)**: string maxLength=50 — Recipient's email
    - `phone` **(required)**: string maxLength=20 — Recipient's phone in INTERNATIONAL format
- `items` **(required)**: array
  - `[item]`: object
    - `id` **(required)**: string — Product ID
    - `quantity` **(required)**: integer minimum=1 — Ordered quantity
- `notification`: object
  - `confirmed`: string maxLength=255 — URL is called when the order is confirmed and enters packing process
  - `sent`: string maxLength=255 — URL is called when the order is sent
  - `delivered`: string maxLength=255 — URL is called when the order is completed
  - `returned`: string maxLength=255 — URL is called when order is delivered
  - `ticket_created`: string maxLength=255 — URL is called when ticket is created
  - `ticket_updated`: string maxLength=255 — URL is called when ticket is updated
  - `ticket_closed`: string maxLength=255 — URL is called when ticket is closed
- `invoice`: string maxLength=255 — Link to the pdf invoice file
- `invoice_date`: string — Invoice date
- `note`: string maxLength=250 — Order note (used for fulfillment centrum - is not sent to recipient)
- `print_delivery_note`: boolean — Set to true to request printing of the delivery note
- `print_sscc`: boolean — Set to true to request printing of the SSCC label
- invoice_detail (allOf):
  - `number` **(required)**: string maxLength=40 — Invoice number
  - `total` **(required)**: number — Total invoice amount
  - `currency` **(required)**: string maxLength=3 — Invoice currency
  - `date_of_issue` **(required)**: string date — Invoice date in YYYY-MM-DD format
  - `products`: array — Products on the invoice
    - `[item]`: object
      - `code` **(required)**: string maxLength=255 — Product code
      - `description` **(required)**: string — Product description
      - `hs_code` **(required)**: string maxLength=255 — HS (customs tariff) code
      - `value` **(required)**: number — Product value
      - `quantity` **(required)**: integer — Product quantity
      - `country_of_origin` **(required)**: string — Country of origin in `ISO 3166-1 alpha-2` format
  - `fees`: array — Additional invoice lines (shipping, discounts, etc.)
    - `[item]`: object
      - `type` **(required)**: string enum=shipping,other,discount — Fee type
      - `description` **(required)**: string — Fee description
      - `value` **(required)**: number — Fee value

**Response 200** — OK

- `id`: string — Unique order identification code
- `uid`: string — Internal order UID
- `variable_symbol`: string — Variable symbol
- `status`: string — Order status
- `created_at`: string — Order creation date
- `shipped_at`: string|null — Date when order was shipped
- `delivered_at`: string|null — Date when order was delivered
- `returned_at`: string|null — Date when the shipment was returned (`null` if the order has not been returned). Independent of `status`: `status` describes the order, `returned_at` and `return_type` describe the return record itself.
- `return_type`: string|null enum=return,claim,write_off — How the return was recorded - `return` (shipment came back from the carrier), `claim` (returned by the customer) or `write_off`. `null` if the order has not been returned. In practice almost always `return`.
- `parcel_service`: string — Preferred parcel service code
- `delivery_point`: string|null — Delivery point code (only if delivery to the delivery point)
- `cod`: number — Cash on delivery amount
- `value`: number — Order value
- `invoice`: string — Link to the pdf invoice file
- `invoice_number`: string — Invoice number
- `invoice_date`: string|null — Invoice date
- `note`: string — Order note (used for fulfillment centrum - is not sent to recipient)
- `print_delivery_note`: boolean — Delivery note print preference (`false` when not provided)
- `print_sscc`: boolean — SSCC label print preference (`false` when not provided)
- `sscc`: string|null — 18-digit order-level SSCC code, `null` if not yet issued
- `packing_packages`: array — Per packing-package SSCC codes, empty array if none
  - `[item]`: object
    - `number`: integer — Packing package number
    - `sscc`: string — 18-digit packing-package SSCC code
- `sender`: string|null — Preferred sender code
- `recipient`: object
  - `address`: object
    - `name`: string — Name and surname of the recipient
    - `street`: string — Delivery address
    - `city`: string — Delivery city
    - `zip`: string — Delivery postal code
    - `province`: string — Delivery province, if country has provinces
    - `country`: string — Delivery country in `ISO 3166-1 alpha-2` format
  - `contact` **(required)**: object
    - `email`: string maxLength=50 — Recipient's email
    - `phone`: string maxLength=20 — Recipient's phone in INTERNATIONAL format
- `notification`: object
  - `confirmed`: string — URL is called when the order is confirmed and enters packing process
  - `sent`: string — URL is called when the order is sent
  - `delivered`: string — URL is called when the order is completed
  - `returned`: string — URL is called when order is delivered
  - `ticket_created`: string — URL is called when ticket is created
  - `ticket_updated`: string — URL is called when ticket is updated
  - `ticket_closed`: string — URL is called when ticket is closed
- `tracking_numbers`: array — List of assigned tracking numbers
  - `[item]`: string
- `tracking_links`: array — List of tracking url (if available for selected delivery service)
  - `[item]`: string
- `items` **(required)**: array
  - `[item]`: object
    - `id` **(required)**: string — Product ID
    - `quantity` **(required)**: integer — Ordered quantity
    - `serial_numbers`: array — Serial numbers assigned to the ordered units
      - `[item]`: string
- `packages`: array — List of shipped packages
  - `[item]`: object
    - `tracking_number`: string|null — Package tracking number
    - `weight`: number — Package weight
    - `package_dimension`: object|null — Package dimensions and volumetric weight
      - `length`: number|null
      - `width`: number|null
      - `height`: number|null
      - `volumetric_weight`: number|null
- `attributes`: array — Order attributes exposed to the API
  - `[item]`: object
    - `key` **(required)**: string — Attribute key
    - `value` **(required)**: string — Attribute value
- `tracking_events`: array — List of tracking events
  - `[item]`: object
    - `date`: string — Event date
    - `message`: string — Event message
    - `event_code`: string|null — Internal event code
    - `carrier_event_code`: string|null — Carrier event code
- `package_returns`: array — List of return tracking numbers
  - `[item]`: object
    - `tracking`: string — Original package tracking number
    - `return_tracking`: string — Return tracking number
- `proof_of_delivery`: object — Name of the package recipient and the date of receipt. Only if parcel service provide these information
  - `recipient`: string — Name of the package recipient
  - `date`: string — Date of receipt
- invoice_detail (allOf):
  - `number` **(required)**: string maxLength=40 — Invoice number
  - `total` **(required)**: number — Total invoice amount
  - `currency` **(required)**: string maxLength=3 — Invoice currency
  - `date_of_issue` **(required)**: string date — Invoice date in YYYY-MM-DD format
  - `products`: array — Products on the invoice
    - `[item]`: object
      - `code` **(required)**: string maxLength=255 — Product code
      - `description` **(required)**: string — Product description
      - `hs_code` **(required)**: string maxLength=255 — HS (customs tariff) code
      - `value` **(required)**: number — Product value
      - `quantity` **(required)**: integer — Product quantity
      - `country_of_origin` **(required)**: string — Country of origin in `ISO 3166-1 alpha-2` format
  - `fees`: array — Additional invoice lines (shipping, discounts, etc.)
    - `[item]`: object
      - `type` **(required)**: string enum=shipping,other,discount — Fee type
      - `description` **(required)**: string — Fee description
      - `value` **(required)**: number — Fee value

```json
{
 "response": {
  "id": "AB12345",
  "uid": "3c7ac0f0ab",
  "variable_symbol": "12345",
  "status": "imported",
  "created_at": "2022-07-12T10:30:00+0100",
  "shipped_at": "2022-07-13T14:00:00+0100",
  "delivered_at": "2022-07-15T09:00:00+0100",
  "parcel_service": "remax",
  "cod": 0,
  "value": 15.35,
  "invoice": "http://example.com/order/inv123.pdf",
  "note": "Order note",
  "print_delivery_note": false,
  "print_sscc": false,
  "sscc": "085860288700000423",
  "packing_packages": [
   {
    "number": 1,
    "sscc": "085860288700000567"
   }
  ],
  "sender": "SHOP_XY",
  "recipient": {
   "address": {
    "name": "Martin Novák",
    "street": "Hronská 35",
    "city": "Zvolen",
    "zip": "96001",
    "province": "",
    "country": "sk"
   },
   "contact": {
    "email": "email@example.com",
    "phone": "+421900123456"
   }
  },
  "items": [
   {
    "id": "12345",
    "quantity": 1,
    "serial_numbers": [
     "ABCD-123-456-789"
    ]
   }
  ],
  "notification": {
   "confirmed": "http://example.com/api/order/123/confirm",
   "sent": "http://example.com/api/order/123/sent",
   "delivered": "http://example.com/api/order/123/delivered",
   "returned": "http://example.com/api/order/123/returned",
   "ticket_created": "http://example.com/api/order/123/ticket/created",
   "ticket_updated": "http://example.com/api/order/123/ticket/updated",
   "ticket_closed": "http://example.com/api/order/123/ticket/closed"
  },
  "tracking_numbers": [],
  "tracking_links": [],
  "tracking_events": [],
  "proof_of_delivery": {
   "recipient": "Martin Novák",
   "date": "2018-11-06T09:11:20+0100"
  }
 }
}
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```


---
## GET `/order` — Reading order

Returns order detail and status. Either `id` **or** `tracking` must be provided. Supplying both is allowed,
but at least one is required.

**Parameters**

- `id` (query): string  — An unique identifier of the order. Either `id` or `tracking` must be provided
- `tracking` (query): string  — Package tracking number. Either `id` or `tracking` must be provided

**Response 200** — OK

- `id`: string — Unique order identification code
- `uid`: string — Internal order UID
- `variable_symbol`: string — Variable symbol
- `status`: string — Order status
- `created_at`: string — Order creation date
- `shipped_at`: string|null — Date when order was shipped
- `delivered_at`: string|null — Date when order was delivered
- `returned_at`: string|null — Date when the shipment was returned (`null` if the order has not been returned). Independent of `status`: `status` describes the order, `returned_at` and `return_type` describe the return record itself.
- `return_type`: string|null enum=return,claim,write_off — How the return was recorded - `return` (shipment came back from the carrier), `claim` (returned by the customer) or `write_off`. `null` if the order has not been returned. In practice almost always `return`.
- `parcel_service`: string — Preferred parcel service code
- `delivery_point`: string|null — Delivery point code (only if delivery to the delivery point)
- `cod`: number — Cash on delivery amount
- `value`: number — Order value
- `invoice`: string — Link to the pdf invoice file
- `invoice_number`: string — Invoice number
- `invoice_date`: string|null — Invoice date
- `note`: string — Order note (used for fulfillment centrum - is not sent to recipient)
- `print_delivery_note`: boolean — Delivery note print preference (`false` when not provided)
- `print_sscc`: boolean — SSCC label print preference (`false` when not provided)
- `sscc`: string|null — 18-digit order-level SSCC code, `null` if not yet issued
- `packing_packages`: array — Per packing-package SSCC codes, empty array if none
  - `[item]`: object
    - `number`: integer — Packing package number
    - `sscc`: string — 18-digit packing-package SSCC code
- `sender`: string|null — Preferred sender code
- `recipient`: object
  - `address`: object
    - `name`: string — Name and surname of the recipient
    - `street`: string — Delivery address
    - `city`: string — Delivery city
    - `zip`: string — Delivery postal code
    - `province`: string — Delivery province, if country has provinces
    - `country`: string — Delivery country in `ISO 3166-1 alpha-2` format
  - `contact` **(required)**: object
    - `email`: string maxLength=50 — Recipient's email
    - `phone`: string maxLength=20 — Recipient's phone in INTERNATIONAL format
- `notification`: object
  - `confirmed`: string — URL is called when the order is confirmed and enters packing process
  - `sent`: string — URL is called when the order is sent
  - `delivered`: string — URL is called when the order is completed
  - `returned`: string — URL is called when order is delivered
  - `ticket_created`: string — URL is called when ticket is created
  - `ticket_updated`: string — URL is called when ticket is updated
  - `ticket_closed`: string — URL is called when ticket is closed
- `tracking_numbers`: array — List of assigned tracking numbers
  - `[item]`: string
- `tracking_links`: array — List of tracking url (if available for selected delivery service)
  - `[item]`: string
- `items` **(required)**: array
  - `[item]`: object
    - `id` **(required)**: string — Product ID
    - `quantity` **(required)**: integer — Ordered quantity
    - `serial_numbers`: array — Serial numbers assigned to the ordered units
      - `[item]`: string
- `packages`: array — List of shipped packages
  - `[item]`: object
    - `tracking_number`: string|null — Package tracking number
    - `weight`: number — Package weight
    - `package_dimension`: object|null — Package dimensions and volumetric weight
      - `length`: number|null
      - `width`: number|null
      - `height`: number|null
      - `volumetric_weight`: number|null
- `attributes`: array — Order attributes exposed to the API
  - `[item]`: object
    - `key` **(required)**: string — Attribute key
    - `value` **(required)**: string — Attribute value
- `tracking_events`: array — List of tracking events
  - `[item]`: object
    - `date`: string — Event date
    - `message`: string — Event message
    - `event_code`: string|null — Internal event code
    - `carrier_event_code`: string|null — Carrier event code
- `package_returns`: array — List of return tracking numbers
  - `[item]`: object
    - `tracking`: string — Original package tracking number
    - `return_tracking`: string — Return tracking number
- `proof_of_delivery`: object — Name of the package recipient and the date of receipt. Only if parcel service provide these information
  - `recipient`: string — Name of the package recipient
  - `date`: string — Date of receipt
- invoice_detail (allOf):
  - `number` **(required)**: string maxLength=40 — Invoice number
  - `total` **(required)**: number — Total invoice amount
  - `currency` **(required)**: string maxLength=3 — Invoice currency
  - `date_of_issue` **(required)**: string date — Invoice date in YYYY-MM-DD format
  - `products`: array — Products on the invoice
    - `[item]`: object
      - `code` **(required)**: string maxLength=255 — Product code
      - `description` **(required)**: string — Product description
      - `hs_code` **(required)**: string maxLength=255 — HS (customs tariff) code
      - `value` **(required)**: number — Product value
      - `quantity` **(required)**: integer — Product quantity
      - `country_of_origin` **(required)**: string — Country of origin in `ISO 3166-1 alpha-2` format
  - `fees`: array — Additional invoice lines (shipping, discounts, etc.)
    - `[item]`: object
      - `type` **(required)**: string enum=shipping,other,discount — Fee type
      - `description` **(required)**: string — Fee description
      - `value` **(required)**: number — Fee value

```json
{
 "response": {
  "id": "AB12345",
  "variable_symbol": "12345",
  "status": "imported",
  "created_at": "2022-07-12T10:30:00+0100",
  "shipped_at": "2022-07-13T14:00:00+0100",
  "delivered_at": "2022-07-15T09:00:00+0100",
  "parcel_service": "remax",
  "delivery_point": "12345",
  "cod": 0,
  "value": 15.35,
  "invoice": "http://example.com/order/inv123.pdf",
  "note": "Order note",
  "print_delivery_note": false,
  "print_sscc": false,
  "sscc": "085860288700000423",
  "packing_packages": [
   {
    "number": 1,
    "sscc": "085860288700000567"
   }
  ],
  "sender": "SHOP_XY",
  "recipient": {
   "address": {
    "name": "Martin Novák",
    "street": "Hronská 35",
    "city": "Zvolen",
    "zip": "96001",
    "province": "",
    "country": "sk"
   },
   "contact": {
    "email": "email@example.com",
    "phone": "+421900123456"
   }
  },
  "items": [
   {
    "id": "12345",
    "quantity": 1,
    "serial_numbers": [
     "ABCD-123-456-789"
    ]
   }
  ],
  "packages": [
   {
    "tracking_number": "VC23EWQD23",
    "weight": 1.23,
    "package_dimension": {
     "length": 30.5,
     "width": 20,
     "height": 15.5,
     "volumetric_weight": 0.189
    }
   }
  ],
  "notification": {
   "confirmed": "http://example.com/api/order/123/confirm",
   "sent": "http://example.com/api/order/123/sent",
   "delivered": "http://example.com/api/order/123/delivered",
   "returned": "http://example.com/api/order/123/returned",
   "ticket_created": "http://example.com/api/order/123/ticket/created",
   "ticket_updated": "http://example.com/api/order/123/ticket/updated",
   "ticket_closed": "http://example.com/api/order/123/ticket/closed"
  },
  "tracking_numbers": [],
  "tracking_links": [],
  "tracking_events": [
   {
    "date": "2021-01-10T06:00:00+0200",
    "message": "received data",
    "event_code": "PRG",
    "carrier_event_code": "1"
   },
   {
    "date": "2021-01-10T18:00:00+0200",
    "message": "arrived",
    "event_code": "PRE",
    "carrier_event_code": "3"
   },
   {
    "date": "2021-01-11T08:00:00+0200",
    "message": "prepared for departure",
    "event_code": "IDP",
    "carrier_event_code": "4"
   },
   {
    "date": "2021-01-12T12:00:00+0200",
    "message": "ready for pickup",
    "event_code": "DPL",
    "carrier_event_code": "5"
   }
  ],
  "package_returns": [
   {
    "tracking": "PACKAGEXYZ",
    "return_tracking": "RETURN123456"
   }
  ],
  "proof_of_delivery": {
   "recipient": "Martin Novák",
   "date": "2018-11-06T09:11:20+0100"
  }
 }
}
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```


---
## DELETE `/order` — Deleting order

Deleting an order is only possible if it is in pending status.

**Parameters**

- `id` (query) **required**: string  — An unique identifier of the order.

**Response 204** — No Content

**Response 400** — Bad Request

- `message`: string
- `violations`: object
  - `id`: array
    - `[item]`: object
      - `code`: string
      - `message`: string

```json
{
 "response": {
  "message": "Invalid request",
  "violations": {
   "id": [
    {
     "code": "NOT_UPDATABLE_ORDER_ERROR",
     "message": "Order cannot be modified in current state."
    }
   ]
  }
 }
}
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```


---
## PUT `/order/invoice` — Updating order invoice details

Updates only the invoice details (customs information) of an existing order. This operation is allowed only for orders in specific statuses: `new`, `imported`, `b2b_new`, `packed`.

**Parameters**

- `id` (query) **required**: string  — An unique identifier of the order.

**Request body** (application/json)

- invoice_detail (allOf):
  - `number` **(required)**: string maxLength=40 — Invoice number
  - `total` **(required)**: number — Total invoice amount
  - `currency` **(required)**: string maxLength=3 — Invoice currency
  - `date_of_issue` **(required)**: string date — Invoice date in YYYY-MM-DD format
  - `products`: array — Products on the invoice
    - `[item]`: object
      - `code` **(required)**: string maxLength=255 — Product code
      - `description` **(required)**: string — Product description
      - `hs_code` **(required)**: string maxLength=255 — HS (customs tariff) code
      - `value` **(required)**: number — Product value
      - `quantity` **(required)**: integer — Product quantity
      - `country_of_origin` **(required)**: string — Country of origin in `ISO 3166-1 alpha-2` format
  - `fees`: array — Additional invoice lines (shipping, discounts, etc.)
    - `[item]`: object
      - `type` **(required)**: string enum=shipping,other,discount — Fee type
      - `description` **(required)**: string — Fee description
      - `value` **(required)**: number — Fee value

**Response 200** — OK

- `id`: string — Unique order identification code
- `uid`: string — Internal order UID
- `variable_symbol`: string — Variable symbol
- `status`: string — Order status
- `created_at`: string — Order creation date
- `shipped_at`: string|null — Date when order was shipped
- `delivered_at`: string|null — Date when order was delivered
- `returned_at`: string|null — Date when the shipment was returned (`null` if the order has not been returned). Independent of `status`: `status` describes the order, `returned_at` and `return_type` describe the return record itself.
- `return_type`: string|null enum=return,claim,write_off — How the return was recorded - `return` (shipment came back from the carrier), `claim` (returned by the customer) or `write_off`. `null` if the order has not been returned. In practice almost always `return`.
- `parcel_service`: string — Preferred parcel service code
- `delivery_point`: string|null — Delivery point code (only if delivery to the delivery point)
- `cod`: number — Cash on delivery amount
- `value`: number — Order value
- `invoice`: string — Link to the pdf invoice file
- `invoice_number`: string — Invoice number
- `invoice_date`: string|null — Invoice date
- `note`: string — Order note (used for fulfillment centrum - is not sent to recipient)
- `print_delivery_note`: boolean — Delivery note print preference (`false` when not provided)
- `print_sscc`: boolean — SSCC label print preference (`false` when not provided)
- `sscc`: string|null — 18-digit order-level SSCC code, `null` if not yet issued
- `packing_packages`: array — Per packing-package SSCC codes, empty array if none
  - `[item]`: object
    - `number`: integer — Packing package number
    - `sscc`: string — 18-digit packing-package SSCC code
- `sender`: string|null — Preferred sender code
- `recipient`: object
  - `address`: object
    - `name`: string — Name and surname of the recipient
    - `street`: string — Delivery address
    - `city`: string — Delivery city
    - `zip`: string — Delivery postal code
    - `province`: string — Delivery province, if country has provinces
    - `country`: string — Delivery country in `ISO 3166-1 alpha-2` format
  - `contact` **(required)**: object
    - `email`: string maxLength=50 — Recipient's email
    - `phone`: string maxLength=20 — Recipient's phone in INTERNATIONAL format
- `notification`: object
  - `confirmed`: string — URL is called when the order is confirmed and enters packing process
  - `sent`: string — URL is called when the order is sent
  - `delivered`: string — URL is called when the order is completed
  - `returned`: string — URL is called when order is delivered
  - `ticket_created`: string — URL is called when ticket is created
  - `ticket_updated`: string — URL is called when ticket is updated
  - `ticket_closed`: string — URL is called when ticket is closed
- `tracking_numbers`: array — List of assigned tracking numbers
  - `[item]`: string
- `tracking_links`: array — List of tracking url (if available for selected delivery service)
  - `[item]`: string
- `items` **(required)**: array
  - `[item]`: object
    - `id` **(required)**: string — Product ID
    - `quantity` **(required)**: integer — Ordered quantity
    - `serial_numbers`: array — Serial numbers assigned to the ordered units
      - `[item]`: string
- `packages`: array — List of shipped packages
  - `[item]`: object
    - `tracking_number`: string|null — Package tracking number
    - `weight`: number — Package weight
    - `package_dimension`: object|null — Package dimensions and volumetric weight
      - `length`: number|null
      - `width`: number|null
      - `height`: number|null
      - `volumetric_weight`: number|null
- `attributes`: array — Order attributes exposed to the API
  - `[item]`: object
    - `key` **(required)**: string — Attribute key
    - `value` **(required)**: string — Attribute value
- `tracking_events`: array — List of tracking events
  - `[item]`: object
    - `date`: string — Event date
    - `message`: string — Event message
    - `event_code`: string|null — Internal event code
    - `carrier_event_code`: string|null — Carrier event code
- `package_returns`: array — List of return tracking numbers
  - `[item]`: object
    - `tracking`: string — Original package tracking number
    - `return_tracking`: string — Return tracking number
- `proof_of_delivery`: object — Name of the package recipient and the date of receipt. Only if parcel service provide these information
  - `recipient`: string — Name of the package recipient
  - `date`: string — Date of receipt
- invoice_detail (allOf):
  - `number` **(required)**: string maxLength=40 — Invoice number
  - `total` **(required)**: number — Total invoice amount
  - `currency` **(required)**: string maxLength=3 — Invoice currency
  - `date_of_issue` **(required)**: string date — Invoice date in YYYY-MM-DD format
  - `products`: array — Products on the invoice
    - `[item]`: object
      - `code` **(required)**: string maxLength=255 — Product code
      - `description` **(required)**: string — Product description
      - `hs_code` **(required)**: string maxLength=255 — HS (customs tariff) code
      - `value` **(required)**: number — Product value
      - `quantity` **(required)**: integer — Product quantity
      - `country_of_origin` **(required)**: string — Country of origin in `ISO 3166-1 alpha-2` format
  - `fees`: array — Additional invoice lines (shipping, discounts, etc.)
    - `[item]`: object
      - `type` **(required)**: string enum=shipping,other,discount — Fee type
      - `description` **(required)**: string — Fee description
      - `value` **(required)**: number — Fee value

```json
{
 "response": {
  "id": "AB12345",
  "variable_symbol": "12345",
  "status": "imported",
  "created_at": "2022-07-12T10:30:00+0100",
  "shipped_at": "2022-07-13T14:00:00+0100",
  "delivered_at": "2022-07-15T09:00:00+0100",
  "parcel_service": "remax",
  "delivery_point": "12345",
  "cod": 0,
  "value": 15.35,
  "invoice": "http://example.com/order/inv123.pdf",
  "invoice_number": "202207120001",
  "invoice_date": "2022-07-12",
  "note": "Order note",
  "sscc": "085860288700000423",
  "packing_packages": [
   {
    "number": 1,
    "sscc": "085860288700000567"
   }
  ],
  "sender": "SHOP_XY",
  "recipient": {
   "address": {
    "name": "Martin Novák",
    "street": "Hronská 35",
    "city": "Zvolen",
    "zip": "96001",
    "province": "",
    "country": "sk"
   },
   "contact": {
    "email": "email@example.com",
    "phone": "+421900123456"
   }
  },
  "items": [
   {
    "id": "12345",
    "quantity": 1
   }
  ],
  "invoice_detail": {
   "number": "202201397",
   "total": 353,
   "currency": "USD",
   "date_of_issue": "2022-11-30",
   "products": [
    {
     "code": "44434",
     "description": "\"Updated product description\"",
     "hs_code": "64039198",
     "value": 169,
     "quantity": 1,
     "country_of_origin": "CZ"
    }
   ],
   "fees": [
    {
     "type": "shipping",
     "description": "Shipping cost",
     "value": 10
    }
   ]
  },
  "tracking_numbers": [],
  "tracking_links": [],
  "tracking_events": [],
  "proof_of_delivery": {
   "recipient": "Martin Novák",
   "date": "2018-11-06T09:11:20+0100"
  }
 }
}
```

**Response 400** — Bad Request

- `message`: string
- `violations`: object
  - `id`: array
    - `[item]`: object
      - `code`: string
      - `message`: string

```json
{
 "response": {
  "message": "Invalid request",
  "violations": {
   "id": [
    {
     "code": "NOT_UPDATABLE_ORDER_INVOICE_ERROR",
     "message": "Order invoice data cannot be modified in current state."
    }
   ]
  }
 }
}
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```


---
## GET `/order/history` — Reading order history

Limit 100 orders per page.

**Parameters**

- `from` (query): string  — Orders created after the date
- `to` (query): string  — Orders created before the date
- `status` (query): string  — Filter by order status (pending,confirmed,sent,returned,rejected,delivered)
- `page` (query): integer  — Page number

**Response 200** — OK

- `page`: integer — Page number
- `total`: integer — Total order count
- `orders`: array
  - `[item]`: object
    - `id`: string — Unique order identification code
    - `uid`: string — Internal order UID
    - `variable_symbol`: string — Variable symbol
    - `status`: string — Order status
    - `created_at`: string — Order creation date
    - `shipped_at`: string|null — Date when order was shipped
    - `delivered_at`: string|null — Date when order was delivered
    - `returned_at`: string|null — Date when the shipment was returned (`null` if the order has not been returned). Independent of `status`: `status` describes the order, `returned_at` and `return_type` describe the return record itself.
    - `return_type`: string|null enum=return,claim,write_off — How the return was recorded - `return` (shipment came back from the carrier), `claim` (returned by the customer) or `write_off`. `null` if the order has not been returned. In practice almost always `return`.
    - `parcel_service`: string — Preferred parcel service code
    - `delivery_point`: string|null — Delivery point code (only if delivery to the delivery point)
    - `cod`: number — Cash on delivery amount
    - `value`: number — Order value
    - `invoice`: string — Link to the pdf invoice file
    - `invoice_number`: string — Invoice number
    - `invoice_date`: string|null — Invoice date
    - `note`: string — Order note (used for fulfillment centrum - is not sent to recipient)
    - `print_delivery_note`: boolean — Delivery note print preference (`false` when not provided)
    - `print_sscc`: boolean — SSCC label print preference (`false` when not provided)
    - `sscc`: string|null — 18-digit order-level SSCC code, `null` if not yet issued
    - `packing_packages`: array — Per packing-package SSCC codes, empty array if none
      - `[item]`: object
        - `number`: integer — Packing package number
        - `sscc`: string — 18-digit packing-package SSCC code
    - `sender`: string|null — Preferred sender code
    - `recipient`: object
      - `address`: object
        - `name`: string — Name and surname of the recipient
        - `street`: string — Delivery address
        - `city`: string — Delivery city
        - `zip`: string — Delivery postal code
        - `province`: string — Delivery province, if country has provinces
        - `country`: string — Delivery country in `ISO 3166-1 alpha-2` format
      - `contact` **(required)**: object
        - `email`: string maxLength=50 — Recipient's email
        - `phone`: string maxLength=20 — Recipient's phone in INTERNATIONAL format
    - `notification`: object
      - `confirmed`: string — URL is called when the order is confirmed and enters packing process
      - `sent`: string — URL is called when the order is sent
      - `delivered`: string — URL is called when the order is completed
      - `returned`: string — URL is called when order is delivered
      - `ticket_created`: string — URL is called when ticket is created
      - `ticket_updated`: string — URL is called when ticket is updated
      - `ticket_closed`: string — URL is called when ticket is closed
    - `tracking_numbers`: array — List of assigned tracking numbers
      - `[item]`: string
    - `tracking_links`: array — List of tracking url (if available for selected delivery service)
      - `[item]`: string
    - `items` **(required)**: array
      - `[item]`: object
        - `id` **(required)**: string — Product ID
        - `quantity` **(required)**: integer — Ordered quantity
        - `serial_numbers`: array — Serial numbers assigned to the ordered units
          - `[item]`: string
    - `packages`: array — List of shipped packages
      - `[item]`: object
        - `tracking_number`: string|null — Package tracking number
        - `weight`: number — Package weight
        - `package_dimension`: object|null — Package dimensions and volumetric weight
          - `length`: number|null
          - `width`: number|null
          - `height`: number|null
          - `volumetric_weight`: number|null
    - `attributes`: array — Order attributes exposed to the API
      - `[item]`: object
        - `key` **(required)**: string — Attribute key
        - `value` **(required)**: string — Attribute value
    - `tracking_events`: array — List of tracking events
      - `[item]`: object
        - `date`: string — Event date
        - `message`: string — Event message
        - `event_code`: string|null — Internal event code
        - `carrier_event_code`: string|null — Carrier event code
    - `package_returns`: array — List of return tracking numbers
      - `[item]`: object
        - `tracking`: string — Original package tracking number
        - `return_tracking`: string — Return tracking number
    - `proof_of_delivery`: object — Name of the package recipient and the date of receipt. Only if parcel service provide these information
      - `recipient`: string — Name of the package recipient
      - `date`: string — Date of receipt
    - invoice_detail (allOf):
      - `number` **(required)**: string maxLength=40 — Invoice number
      - `total` **(required)**: number — Total invoice amount
      - `currency` **(required)**: string maxLength=3 — Invoice currency
      - `date_of_issue` **(required)**: string date — Invoice date in YYYY-MM-DD format
      - `products`: array — Products on the invoice
        - `[item]`: object
          - `code` **(required)**: string maxLength=255 — Product code
          - `description` **(required)**: string — Product description
          - `hs_code` **(required)**: string maxLength=255 — HS (customs tariff) code
          - `value` **(required)**: number — Product value
          - `quantity` **(required)**: integer — Product quantity
          - `country_of_origin` **(required)**: string — Country of origin in `ISO 3166-1 alpha-2` format
      - `fees`: array — Additional invoice lines (shipping, discounts, etc.)
        - `[item]`: object
          - `type` **(required)**: string enum=shipping,other,discount — Fee type
          - `description` **(required)**: string — Fee description
          - `value` **(required)**: number — Fee value

```json
{
 "response": {
  "page": 1,
  "total": 245,
  "orders": [
   {
    "id": "AB12345",
    "variable_symbol": "12345",
    "status": "imported",
    "created_at": "2022-07-12T10:30:00+0100",
    "shipped_at": "2022-07-13T14:00:00+0100",
    "delivered_at": "2022-07-15T09:00:00+0100",
    "parcel_service": "remax",
    "delivery_point": "12345",
    "cod": 0,
    "value": 15.35,
    "invoice": "http://example.com/order/inv123.pdf",
    "note": "Order note",
    "sender": "SHOP_XY",
    "recipient": {
     "address": {
      "name": "Martin Novák",
      "street": "Hronská 35",
      "city": "Zvolen",
      "zip": "96001",
      "province": "",
      "country": "sk"
     },
     "contact": {
      "email": "email@example.com",
      "phone": "+421900123456"
     }
    },
    "items": [
     {
      "id": "12345",
      "quantity": 1,
      "serial_numbers": [
       "ABCD-123-456-789"
      ]
     }
    ],
    "packages": [
     {
      "tracking_number": "VC23EWQD23",
      "weight": 1.23,
      "package_dimension": {
       "length": 30.5,
       "width": 20,
       "height": 15.5,
       "volumetric_weight": 0.189
      }
     }
    ],
    "notification": {
     "confirmed": "http://example.com/api/order/123/confirm",
     "sent": "http://example.com/api/order/123/sent",
     "delivered": "http://example.com/api/order/123/delivered",
     "returned": "http://example.com/api/order/123/returned",
     "ticket_created": "http://example.com/api/order/123/ticket/created",
     "ticket_updated": "http://example.com/api/order/123/ticket/updated",
     "ticket_closed": "http://example.com/api/order/123/ticket/closed"
    },
    "tracking_numbers": [],
    "tracking_links": [],
    "tracking_events": [
     {
      "date": "2021-01-10T06:00:00+0200",
      "message": "received data",
      "event_code": "PRG",
      "carrier_event_code": "1"
     },
     {
      "date": "2021-01-10T18:00:00+0200",
      "message": "arrived",
      "event_code": "PRE",
      "carrier_event_code": "3"
     },
     {
      "date": "2021-01-11T08:00:00+0200",
      "message": "prepared for departure",
      "event_code": "IDP",
      "carrier_event_code": "4"
     },
     {
      "date": "2021-01-12T12:00:00+0200",
      "message": "ready for pickup",
      "event_code": "DPL",
      "carrier_event_code": "5"
     }
    ],
    "proof_of_delivery": {
     "recipient": "Martin Novák",
     "date": "2018-11-06T09:11:20+0100"
    }
   }
  ]
 }
}
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```


---
## POST `/order/files` — Uploading order attachment

Uploading invoices and additional documents for printing and packing

- Only PDF file type is allowed

- Only A4 page format is supported

- Only text pages are allowed (no A4 image instead of page)

**Parameters**

- `id` (query) **required**: string  — Unique order identification code

**Request body** (application/json)

- `type`: string example='invoice' — Attachment type - allowed values `invoice` or `other`
- `name`: string example='Invoice_AB12345.pdf' — File name
- `data`: string example='VEVTVCBEQVRB...' — Base64 encoded file content

**Response 204** — No Content

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```


---
## GET `/cod` — Reading COD info

Returns COD payment info for a single order identified by either `id` or `variable_symbol`.
Only orders with `cod > 0` are returned. Orders without COD return `404`.

**Parameters**

- `id` (query): string  — Order external id
- `variable_symbol` (query): string  — Order variable symbol

**Response 200** — OK

- `id`: string — Order external id
- `uid`: string — Order uid assigned by the fulfillment centrum
- `variable_symbol`: string — Order variable symbol
- `parcel_service`: string — Parcel service code
- `cod`: number — Cash on delivery amount (local currency)
- `status`: string enum=waiting,received,paid — COD payment status
- `received_at`: string|null — Date and time when COD was received from the courier
- `paid_at`: string|null — Date and time when COD was paid out to the seller
- `created_at`: string — Order creation date and time

```json
{
 "response": {
  "id": "AB12345",
  "uid": "2026040001",
  "variable_symbol": "12345",
  "parcel_service": "remax",
  "cod": 42.5,
  "status": "waiting",
  "received_at": "2026-04-20T10:15:00+0200",
  "paid_at": "2026-04-21T09:00:00+0200",
  "created_at": "2026-04-18T14:00:00+0200"
 }
}
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```

**Response 404** — Not Found


---
## GET `/cod/list` — COD list

Paginated list of orders with COD (100 items per page). If `status` is omitted, all orders with `cod > 0` are returned.

The `waiting` filter matches orders that are ready to collect COD from the courier (not yet delivered to the fulfillment centrum).

**Parameters**

- `status` (query): string enum=['waiting', 'received', 'paid'] — Filter by COD status
- `from` (query): string  — Include orders created on or after this date (ISO 8601 date)
- `to` (query): string  — Include orders created on or before this date (ISO 8601 date)
- `page` (query): integer  — Page number (default `1`)

**Response 200** — OK

- `page`: integer — Current page
- `total`: integer — Total number of matching orders
- `items`: array
  - `[item]`: object
    - `id`: string — Order external id
    - `uid`: string — Order uid assigned by the fulfillment centrum
    - `variable_symbol`: string — Order variable symbol
    - `parcel_service`: string — Parcel service code
    - `cod`: number — Cash on delivery amount (local currency)
    - `status`: string enum=waiting,received,paid — COD payment status
    - `received_at`: string|null — Date and time when COD was received from the courier
    - `paid_at`: string|null — Date and time when COD was paid out to the seller
    - `created_at`: string — Order creation date and time

```json
{
 "response": {
  "page": 1,
  "total": 42,
  "items": [
   {
    "id": "AB12345",
    "uid": "2026040001",
    "variable_symbol": "12345",
    "parcel_service": "remax",
    "cod": 42.5,
    "status": "waiting",
    "received_at": "2026-04-20T10:15:00+0200",
    "paid_at": "2026-04-21T09:00:00+0200",
    "created_at": "2026-04-18T14:00:00+0200"
   }
  ]
 }
}
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```


---
## GET `/rma/list` — List returned shipments (RMA)

Paginated list of shipments that came back from the carrier (100 items per page), sorted by order creation date, newest first. Every item uses the same structure as an order response, with `returned_at` and `return_type` filled in.

Cancelled orders (storna) are **not** included. Undelivered and refused shipments are not distinguished - a refused delivery comes back and ends up in the same state as any other undelivered one.

Note that the `from` / `to` filter applies to the **return** date, while the sorting is by order creation date.

**Parameters**

- `from` (query): string  — Include shipments returned on or after this date (ISO 8601 date)
- `to` (query): string  — Include shipments returned on or before this date (ISO 8601 date)
- `page` (query): integer  — Page number (default `1`)

**Response 200** — OK

- `page`: integer — Current page
- `total`: integer — Total number of matching returned shipments
- `items`: array
  - `[item]`: object
    - `id`: string — Unique order identification code
    - `uid`: string — Internal order UID
    - `variable_symbol`: string — Variable symbol
    - `status`: string — Order status
    - `created_at`: string — Order creation date
    - `shipped_at`: string|null — Date when order was shipped
    - `delivered_at`: string|null — Date when order was delivered
    - `returned_at`: string|null — Date when the shipment was returned (`null` if the order has not been returned). Independent of `status`: `status` describes the order, `returned_at` and `return_type` describe the return record itself.
    - `return_type`: string|null enum=return,claim,write_off — How the return was recorded - `return` (shipment came back from the carrier), `claim` (returned by the customer) or `write_off`. `null` if the order has not been returned. In practice almost always `return`.
    - `parcel_service`: string — Preferred parcel service code
    - `delivery_point`: string|null — Delivery point code (only if delivery to the delivery point)
    - `cod`: number — Cash on delivery amount
    - `value`: number — Order value
    - `invoice`: string — Link to the pdf invoice file
    - `invoice_number`: string — Invoice number
    - `invoice_date`: string|null — Invoice date
    - `note`: string — Order note (used for fulfillment centrum - is not sent to recipient)
    - `print_delivery_note`: boolean — Delivery note print preference (`false` when not provided)
    - `print_sscc`: boolean — SSCC label print preference (`false` when not provided)
    - `sscc`: string|null — 18-digit order-level SSCC code, `null` if not yet issued
    - `packing_packages`: array — Per packing-package SSCC codes, empty array if none
      - `[item]`: object
        - `number`: integer — Packing package number
        - `sscc`: string — 18-digit packing-package SSCC code
    - `sender`: string|null — Preferred sender code
    - `recipient`: object
      - `address`: object
        - `name`: string — Name and surname of the recipient
        - `street`: string — Delivery address
        - `city`: string — Delivery city
        - `zip`: string — Delivery postal code
        - `province`: string — Delivery province, if country has provinces
        - `country`: string — Delivery country in `ISO 3166-1 alpha-2` format
      - `contact` **(required)**: object
        - `email`: string maxLength=50 — Recipient's email
        - `phone`: string maxLength=20 — Recipient's phone in INTERNATIONAL format
    - `notification`: object
      - `confirmed`: string — URL is called when the order is confirmed and enters packing process
      - `sent`: string — URL is called when the order is sent
      - `delivered`: string — URL is called when the order is completed
      - `returned`: string — URL is called when order is delivered
      - `ticket_created`: string — URL is called when ticket is created
      - `ticket_updated`: string — URL is called when ticket is updated
      - `ticket_closed`: string — URL is called when ticket is closed
    - `tracking_numbers`: array — List of assigned tracking numbers
      - `[item]`: string
    - `tracking_links`: array — List of tracking url (if available for selected delivery service)
      - `[item]`: string
    - `items` **(required)**: array
      - `[item]`: object
        - `id` **(required)**: string — Product ID
        - `quantity` **(required)**: integer — Ordered quantity
        - `serial_numbers`: array — Serial numbers assigned to the ordered units
          - `[item]`: string
    - `packages`: array — List of shipped packages
      - `[item]`: object
        - `tracking_number`: string|null — Package tracking number
        - `weight`: number — Package weight
        - `package_dimension`: object|null — Package dimensions and volumetric weight
          - `length`: number|null
          - `width`: number|null
          - `height`: number|null
          - `volumetric_weight`: number|null
    - `attributes`: array — Order attributes exposed to the API
      - `[item]`: object
        - `key` **(required)**: string — Attribute key
        - `value` **(required)**: string — Attribute value
    - `tracking_events`: array — List of tracking events
      - `[item]`: object
        - `date`: string — Event date
        - `message`: string — Event message
        - `event_code`: string|null — Internal event code
        - `carrier_event_code`: string|null — Carrier event code
    - `package_returns`: array — List of return tracking numbers
      - `[item]`: object
        - `tracking`: string — Original package tracking number
        - `return_tracking`: string — Return tracking number
    - `proof_of_delivery`: object — Name of the package recipient and the date of receipt. Only if parcel service provide these information
      - `recipient`: string — Name of the package recipient
      - `date`: string — Date of receipt
    - invoice_detail (allOf):
      - `number` **(required)**: string maxLength=40 — Invoice number
      - `total` **(required)**: number — Total invoice amount
      - `currency` **(required)**: string maxLength=3 — Invoice currency
      - `date_of_issue` **(required)**: string date — Invoice date in YYYY-MM-DD format
      - `products`: array — Products on the invoice
        - `[item]`: object
          - `code` **(required)**: string maxLength=255 — Product code
          - `description` **(required)**: string — Product description
          - `hs_code` **(required)**: string maxLength=255 — HS (customs tariff) code
          - `value` **(required)**: number — Product value
          - `quantity` **(required)**: integer — Product quantity
          - `country_of_origin` **(required)**: string — Country of origin in `ISO 3166-1 alpha-2` format
      - `fees`: array — Additional invoice lines (shipping, discounts, etc.)
        - `[item]`: object
          - `type` **(required)**: string enum=shipping,other,discount — Fee type
          - `description` **(required)**: string — Fee description
          - `value` **(required)**: number — Fee value

```json
{
 "response": {
  "page": 1,
  "total": 8,
  "items": [
   {
    "id": "69e73ce4deec1",
    "uid": "KIK00012345",
    "status": "returned",
    "created_at": "2026-04-02T09:12:00+0200",
    "shipped_at": "2026-04-03T16:40:00+0200",
    "delivered_at": null,
    "returned_at": "2026-04-22T10:10:44+0200",
    "return_type": "return",
    "parcel_service": "gls",
    "cod": 0,
    "value": 49.9,
    "recipient": {
     "address": {
      "name": "Jan Novak",
      "street": "Hlavna 1",
      "city": "Bratislava",
      "zip": "81101",
      "country": "SK"
     },
     "contact": {
      "email": "jan.novak@example.com",
      "phone": "+421900123456"
     }
    },
    "tracking_numbers": [
     "123456789"
    ],
    "items": [
     {
      "id": "SKU-001",
      "quantity": 1
     }
    ]
   }
  ]
 }
}
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```


---
## GET `/return/list` — List returns

Paginated list of "local" returns (100 items per page). Sorted by creation date, newest first.

**This is an extra service that has to be activated by the sales department.** If it is not active for your account, the list stays empty. For shipments returned by the carrier use `GET /rma/list` instead.

**Parameters**

- `from` (query): string  — Include returns created on or after this date (ISO 8601 date)
- `to` (query): string  — Include returns created on or before this date (ISO 8601 date)
- `uid` (query): string  — Filter by exact return UID (e.g. `AB00001`)
- `barcode` (query): string  — Filter by an exact scanned package barcode
- `page` (query): integer  — Page number (default `1`)

**Response 200** — OK

- `page`: integer — Current page
- `total`: integer — Total number of matching returns
- `items`: array
  - `[item]`: object
    - `id`: integer — Return id
    - `uid`: string — Return UID
    - `depot_id`: integer — Depot id
    - `type`: string enum=basic,complex — Return type
    - `status`: string — Return status
    - `weight`: number|null — Return weight
    - `created_at`: string — Return creation date and time
    - `barcodes`: array — Scanned package barcodes
      - `[item]`: string
    - `items`: array
      - `[item]`: object
        - `id`: integer — Return item id
        - `barcode`: string|null — Scanned product barcode
        - `description`: string|null — Item description
        - `condition`: string|null — Condition of the returned item
        - `quantity`: integer — Returned quantity
        - `action`: string|null — Action taken with the returned item
    - `photos`: array
      - `[item]`: object
        - `id`: integer — Photo id
        - `type`: string enum=package,content,document — Photo type

```json
{
 "response": {
  "page": 1,
  "total": 42,
  "items": [
   {
    "id": 1024,
    "uid": "AB00001",
    "depot_id": 1,
    "type": "basic",
    "status": "stored",
    "weight": 1.25,
    "created_at": "2026-05-10T09:15:00+0200",
    "barcodes": [
     "CZ123456789",
     "CZ987654321"
    ],
    "items": [
     {
      "id": 17,
      "barcode": "8594000000000",
      "description": "Returned product",
      "condition": "Damaged box",
      "quantity": 1,
      "action": "stock_in"
     }
    ],
    "photos": [
     {
      "id": 51,
      "type": "package"
     }
    ]
   }
  ]
 }
}
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```


---
## GET `/return/{uid}` — Read return detail

Returns full detail of a single return identified by its UID. Response shape matches a single list item.

**Parameters**

- `uid` (path) **required**: string  — Return UID

**Response 200** — OK

- `id`: integer — Return id
- `uid`: string — Return UID
- `depot_id`: integer — Depot id
- `type`: string enum=basic,complex — Return type
- `status`: string — Return status
- `weight`: number|null — Return weight
- `created_at`: string — Return creation date and time
- `barcodes`: array — Scanned package barcodes
  - `[item]`: string
- `items`: array
  - `[item]`: object
    - `id`: integer — Return item id
    - `barcode`: string|null — Scanned product barcode
    - `description`: string|null — Item description
    - `condition`: string|null — Condition of the returned item
    - `quantity`: integer — Returned quantity
    - `action`: string|null — Action taken with the returned item
- `photos`: array
  - `[item]`: object
    - `id`: integer — Photo id
    - `type`: string enum=package,content,document — Photo type

```json
{
 "response": {
  "id": 1024,
  "uid": "AB00001",
  "depot_id": 1,
  "type": "complex",
  "status": "stored",
  "weight": 1.25,
  "created_at": "2026-05-10T09:15:00+0200",
  "barcodes": [],
  "items": [],
  "photos": []
 }
}
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```

**Response 404** — Not Found


---
## GET `/return/{uid}/photo/{photoId}` — Stream return photo

Streams the binary contents of a single return photo. The `Content-Type` header reflects the original upload type (typically `image/jpeg` or `image/png`).

**Parameters**

- `uid` (path) **required**: string  — Return UID
- `photoId` (path) **required**: integer  — Photo id from the return's `photos` array

**Response 200** — OK

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```

**Response 404** — Not Found


---
## GET `/parcel-service` — Available parcel services

**Response 200** — OK

- `[item]`: object
  - `code`: string — Delivery service identification code
  - `name`: string — Delivery service name

```json
[
 {
  "code": "gls",
  "name": "GLS"
 },
 {
  "code": "intime",
  "name": "intime"
 }
]
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```


---
## GET `/delivery-point/{deliveryService}` — Available delivery points

Returns the delivery points of the given parcel service.

Pan-European parcel services (`gls_eu_pudo`, `dpd_eu_pudo`) have too many delivery points to be listed at once, so the `country` query parameter is mandatory for them - the request fails with `400` when it is missing.

When the parcel service has no delivery point in the requested country, the response is `404` - the same as for an unknown parcel service.

**Parameters**

- `deliveryService` (path) **required**: string  — Parcel service identification code
- `country` (query): string  — Two-letter country code the delivery points are filtered by (case-insensitive). Required for `gls_eu_pudo` and `dpd_eu_pudo`, optional for all other parcel services.

**Response 200** — OK

- `[item]`: object
  - `id`: integer
  - `external_code`: string
  - `name`: string
  - `street`: string
  - `city`: string
  - `zip`: string
  - `country`: string

```json
[
 {
  "id": 3100000,
  "external_code": "2285",
  "name": "HUDECZEK SERVICE",
  "street": "Stonavská 340",
  "city": "Albrechtice u Českého Těšína",
  "zip": "73543",
  "country": "cz"
 }
]
```

**Response 400** — Bad Request

- `message` **(required)**: string
- `violations`: object

```json
{
 "missingCountry": {
  "message": "Country parameter is required for \"dpd_eu_pudo\" delivery service"
 },
 "emptyCountry": {
  "message": "Invalid request",
  "violations": {
   "request": [
    "Query request parameter \"country\" should not be empty."
   ]
  }
 }
}
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```

**Response 404** — Not Found

- `message`: string

```json
{
 "message": "No delivery points available for \"invalid\" delivery service"
}
```


---
## POST `/stock-receipt` — Create stock receipt

**Request body** (application/json)

- `id` **(required)**: string maxLength=255 — Unique stock receipt identification code
- `name` **(required)**: string maxLength=50 — Stock receipt name / description
- `delivery_service`: string — Parcel service code of a shipment (must be a valid delivery service code)
- `tracking_code`: string maxLength=255 — Shipment tracking code
- `expected_date`: string date — Expected date of delivery
- `is_bianco`: boolean default=False — Bianco stock receipt flag
- `items` **(required)**: array
  - `[item]`: object
    - `id` **(required)**: string — Product identification code
    - `quantity` **(required)**: integer minimum=1 — Expected quantity

**Response 200** — OK

- `id`: string — Stock receipt identification code
- `status`: string — Stock receipt status
- `name`: string — Stock receipt name / description
- `delivery_service`: string|null — Parcel service code of a shipment
- `tracking_code`: string|null — Shipment tracking code
- `expected_date`: string|null date — Expected date of delivery
- `is_bianco`: boolean — Bianco stock receipt flag
- `created_date`: string — Date and time of stock receipt creation
- `items`: array
  - `[item]`: object
    - `id` **(required)**: string — Product identification code
    - `quantity` **(required)**: integer — Expected quantity
    - `received` **(required)**: integer — Received quantity

```json
{
 "response": {
  "id": "S_12345",
  "status": "created",
  "name": "SHAMPOO_DELIVERY_1",
  "delivery_service": "gls",
  "tracking_code": "TR12345678",
  "expected_date": "2018-10-01",
  "is_bianco": false,
  "created_date": "2018-10-17T13:24:02+0000",
  "items": [
   {
    "id": "AB123",
    "quantity": 10,
    "received": 0
   }
  ]
 }
}
```

**Response 400** — Bad Request

- `message`: string
- `violations`: object

```json
{
 "response": {
  "message": "Invalid request",
  "violations": {
   "items[0].id": [
    {
     "code": "",
     "message": "Product \"MULTI_PRODUCT_TEST\" is multi product"
    }
   ]
  }
 }
}
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```


---
## PUT `/stock-receipt` — Modify stock receipt

Stock receipts in state `created` can be modified.

**Parameters**

- `id` (query) **required**: string  — An unique identifier of the stock receipt.

**Request body** (application/json)

- `name` **(required)**: string maxLength=50 — Stock receipt name / description
- `delivery_service`: string — Parcel service code of a shipment (must be a valid delivery service code)
- `tracking_code`: string maxLength=255 — Shipment tracking code
- `expected_date`: string date — Expected date of delivery
- `is_bianco`: boolean default=False — Bianco stock receipt flag
- `items` **(required)**: array
  - `[item]`: object
    - `id` **(required)**: string — Product identification code
    - `quantity` **(required)**: integer minimum=1 — Expected quantity

**Response 200** — OK

- `id`: string — Stock receipt identification code
- `status`: string — Stock receipt status
- `name`: string — Stock receipt name / description
- `delivery_service`: string|null — Parcel service code of a shipment
- `tracking_code`: string|null — Shipment tracking code
- `expected_date`: string|null date — Expected date of delivery
- `is_bianco`: boolean — Bianco stock receipt flag
- `created_date`: string — Date and time of stock receipt creation
- `items`: array
  - `[item]`: object
    - `id` **(required)**: string — Product identification code
    - `quantity` **(required)**: integer — Expected quantity
    - `received` **(required)**: integer — Received quantity

```json
{
 "response": {
  "id": "S_12345",
  "status": "created",
  "name": "SHAMPOO_DELIVERY_1",
  "delivery_service": "gls",
  "tracking_code": "TR123456789",
  "expected_date": "2018-10-01",
  "is_bianco": false,
  "created_date": "2018-08-30T08:33:30+0000",
  "items": [
   {
    "id": "AB123",
    "quantity": 10,
    "received": 0
   }
  ]
 }
}
```

**Response 400** — Bad Request

- `message`: string
- `violations`: object

```json
{
 "response": {
  "message": "Invalid request",
  "violations": {
   "items[0].id": [
    {
     "code": "",
     "message": "This value should not be blank."
    }
   ]
  }
 }
}
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```


---
## GET `/stock-receipt` — Read stock receipt

Returns stock receipt information

**Parameters**

- `id` (query) **required**: string  — An unique identifier of the stock receipt.

**Response 200** — OK

- `id`: string — Stock receipt identification code
- `status`: string — Stock receipt status
- `name`: string — Stock receipt name / description
- `delivery_service`: string|null — Parcel service code of a shipment
- `tracking_code`: string|null — Shipment tracking code
- `expected_date`: string|null date — Expected date of delivery
- `is_bianco`: boolean — Bianco stock receipt flag
- `created_date`: string — Date and time of stock receipt creation
- `items`: array
  - `[item]`: object
    - `id` **(required)**: string — Product identification code
    - `quantity` **(required)**: integer — Expected quantity
    - `received` **(required)**: integer — Received quantity

```json
{
 "response": {
  "id": "S_12345",
  "status": "created",
  "name": "SHAMPOO_DELIVERY_1",
  "delivery_service": "gls",
  "tracking_code": "TR123456789",
  "expected_date": "2018-10-01",
  "is_bianco": false,
  "created_date": "2018-08-30T08:33:30+0000",
  "items": [
   {
    "id": "AB123",
    "quantity": 10,
    "received": 0
   }
  ]
 }
}
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```

**Response 404** — Not Found

- `message`: string

```json
{
 "message": "Stock receipt S_12345 not found"
}
```


---
## DELETE `/stock-receipt` — Delete stock receipt

Stock receipts in state `created` can be deleted.

**Parameters**

- `id` (query) **required**: string  — An unique identifier of the stock receipt.

**Response 204** — No Content

**Response 400** — Bad Request

- `message`: string
- `violations`: object

```json
{
 "message": "Invalid request"
}
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```


---
## GET `/stock/all` — List stock levels

Returns the current stock levels of all products.

**Response 200** — OK

- `[item]`: object
  - `id`: string — Unique product ID
  - `ean`: string|null — EAN-13
  - `name`: string — Name of the product
  - `quantity`: integer — Stock quantity

```json
{
 "response": [
  {
   "id": "AB123",
   "ean": "8580000001234",
   "name": "Shampoo",
   "quantity": 10
  }
 ]
}
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```


---
## GET `/stock` — Read stock level

Returns the current stock level of a single product.

**Parameters**

- `id` (query) **required**: string  — Product identification code

**Response 200** — OK

- `id`: string — Unique product ID
- `ean`: string|null — EAN-13
- `name`: string — Name of the product
- `quantity`: integer — Stock quantity

```json
{
 "response": {
  "id": "AB123",
  "ean": "8580000001234",
  "name": "Shampoo",
  "quantity": 10
 }
}
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```

**Response 404** — Not Found

- `message`: string

```json
{
 "message": "Product AB123 not found"
}
```


---
## GET `/stock/history/{date}` — Get stock level at date

**Parameters**

- `date` (path) **required**: string  — Requested date

**Response 200** — OK

- `[item]`: object
  - `id`: string — Unique product ID
  - `ean`: string|null — EAN-13
  - `name`: string — Name of the product
  - `quantity`: integer — Stock quantity

```json
{
 "response": [
  {
   "id": "AB123",
   "ean": "8580000001234",
   "name": "Shampoo",
   "quantity": 10
  }
 ]
}
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```


---
## GET `/stock/movements` — Get stock movements

Allow you to retreive the history of stock movements. Limit 500 entries per page.

**Parameters**

- `product` (query): string  — Product identification code
- `receipt` (query): string  — Stock receipt identification code
- `reason` (query): string  — Reason / note / special message related to the stock movement
- `from` (query): string  — Movements after the date
- `to` (query): string  — Movements before the date
- `page` (query): integer  — Page number

**Response 200** — OK

- `page`: integer — Page number
- `total`: integer — Total movement count
- `movements`: array
  - `[item]`: object
    - `id`: integer — Stock movement ID
    - `product`: string — Product identification code
    - `type`: string enum=in,out — Movement direction
    - `change`: integer — Quantity change (positive for in, negative for out)
    - `quantity`: integer — Resulting stock quantity after the movement
    - `date`: string — Date and time of the movement
    - `reason`: string — Reason / note / special message related to the stock movement
    - `order`: string|null — Related order identification code
    - `stock_receipt`: string|null — Related stock receipt identification code

```json
{
 "response": {
  "page": 1,
  "total": 245,
  "movements": [
   {
    "id": 123,
    "product": "P53225",
    "type": "out",
    "change": -1,
    "quantity": 27,
    "date": "2014-06-26T06:07:53+0200",
    "reason": "arrival",
    "order": null,
    "stock_receipt": "S123455"
   }
  ]
 }
}
```

**Response 401** — Missing or invalid authentication token.

- `message`: string

```json
{
 "message": "Unauthorized. Login via POST /login, or use valid token in header"
}
```

