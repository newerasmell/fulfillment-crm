# euShipments (inout.bg) — full API reference

_Auto-rendered from the vendor Postman collection (raw file alongside)._

Welcome to the euShipments public API documentation.

The requests to the API are HTTP GET or HTTP POST. For POST requests the body contains a JSON string; the response is always in JSON format.

**API Base URLs**

| 
**Environment** | 
**Base URL** | 

| 
Test | 
https://test-api.inout.bg/api/v1/ | 

| 
Production | 
https://api1.inout.bg/api/v1/ | 

**Authorization**

Every request must include your API token in the Authorization header, with the keyword "Bearer" before the token:

`Authorization: Bearer <API_TOKEN>`

The API token is provided on request by euShipments.

**How to use any web service**

Web Service URL: BASE_URL + API endpoint

Example for the test environment: https://test-api.inout.bg/api/v1/get-countries

Example for the production environment: https://api1.inout.bg/api/v1/get-countries

## AWB Creation



---
### Shipment_Creation_Web_Service_v1.5

`POST https://api1.inout.bg/api/v1/createAWB`


We can now offer you the ability to ask for a shipment creation directly from your company's software or website by taking advantage of "Shipment Creation".

Requirements

| 
**API Endpoint** | 
**Description** | 

| 
createAWB | 
Creates a new shipment according to the provided API token and the shipment's data. | 

Method: POST
Authorization: Bearer API_TOKEN

Example URLs

| 
**Environment** | 
**URL** | 

| 
Test | 
https://test-api.inout.bg/api/v1/createAWB | 

| 
Production | 
https://api1.inout.bg/api/v1/createAWB | 

API Call Input Fields
Body (JSON)

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
testMode | 
boolean | 
yes | 
 | 
If you want to use the API only for tests, set this field to true. Applies only to the production environment. On the test environment, all shipments save on test env. | 

| 
senderId (company id) | 
integer | 
yes | 
Must be an existing company ID. | 
ID of company, obtain an ID from Companies Web Service. Please for more information, see Companies Web Service. | 

| 
courierId | 
integer | 
no (recommended) | 
Must be an existing courier ID. | 
ID of courier, obtain an ID from Couriers Web Service. If omitted, the system automatically selects the courier configured for the destination country on your account and returns an error if none is configured. We recommend always sending it explicitly. | 

| 
serviceName | 
string | 
no | 
Must be a service supported by the selected courier. | 
Service name, e.g. crossborder (default) or eushipmentsairexpress. If omitted or not supported by the selected courier, the courier's first available service is used, and otherwise the system default (crossborder). | 

| 
waybillAvailableDate | 
date | 
yes | 
Must be between today and 9 days ahead (format YYYY-MM-DD). | 
The date on which the shipment is to be dispatched. | 

| 
responseData.id | 
boolean | 
no | 
 | 
When set to true, the response also contains the internal record id of the created shipment (field id). | 

| 
courierReturnAWB | 
boolean | 
no | 
 | 
Request a courier return AWB together with the shipment, where the courier supports it (e.g. DHL, Zasilkovna, PPL). | 

**recipient**

Addressing: send EITHER recipient.cityId OR recipient.countryIsoCode + recipient.cityName + (recipient.zipCode OR recipient.region).

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
name | 
string | 
yes | 
Max 100 characters. | 
Name of recipient or company. Typically, both customer names (first name and last name) or a company name are filled in. | 

| 
cityId | 
integer | 
conditional | 
Required when countryIsoCode and cityName are not sent. Must be an existing city ID. | 
The ID of the city where the shipment needs to be delivered. Obtain an ID from the Cities resource. Please for more information, see Cities web service. | 

| 
countryIsoCode | 
string | 
conditional | 
Required without cityId. Two-letter uppercase ISO code, e.g. BG, RO, HU. | 
Two-letter country ISO code of the delivery country. | 

| 
cityName | 
string | 
conditional | 
Required without cityId. Max 100 characters. | 
City name. If you have your own nomenclature with cities, you can fill in the fields cityName, zipCode and region instead of cityId. | 

| 
zipCode | 
string | 
conditional | 
Required without cityId and region. Max 15 characters. | 
Zip code. | 

| 
region | 
string | 
conditional | 
Requiered for Romania in case of sending cityName, instead of cityId. | 
Region (county/municipality). | 

| 
officeId | 
integer | 
no | 
Must be an existing office ID. | 
Delivery to a courier office / PUDO / locker: the ID of the office, obtained from Courier_Offices_Web_Service_v1.2. When officeId or officeCode is sent, streetName becomes optional. | 

| 
officeCode | 
string | 
no | 
Must be an existing courier office code. | 
The courier's own office code (field COURIER_OFFICE_CODE in Courier_Offices_Web_Service_v1.2). Alternative to officeId. When either is sent, streetName becomes optional. | 

| 
streetName | 
string | 
conditional | 
Required unless officeId or officeCode is sent. Max 200 characters. | 
Name of the street - e.g. Main street or Main street 10. Legacy option: office delivery can also be requested by adding the keyword "to office: " followed by the office name/address (e.g. " to office: Русе Николаевска") - this is still accepted, but we recommend using officeId or officeCode instead. | 

| 
buildingNumber | 
string or number | 
no | 
Values longer than 8 characters are split: the first 8 characters stay in buildingNumber and the remainder is appended to addressText. | 
Number of the street/building - e.g. 10. | 

| 
addressText | 
string | 
no | 
Max 100 characters. | 
Additional address information - e.g. bl. 25, et. 3. Not all couriers support it. | 

| 
contactPerson | 
string | 
no | 
Max 100 characters. | 
Contact person. Usually the same as the name of the recipient. | 

| 
phoneNumber | 
string | 
yes | 
Max 100 characters. | 
Phone number of the recipient. | 

| 
email | 
string | 
no | 
Not validated. | 
Email of the recipient - highly recommended. If left empty, the system substitutes an internal placeholder address. | 

**awb**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
shipmentType | 
string | 
no | 
Enum: pack, pallet | 
Type of the shipment. Default is pack. For pallet shipments see Shipment_Creation_Web_Service_v1.5 Pallet. | 

| 
parcels | 
integer | 
yes | 
Min 0. | 
Number of parcels in the shipment. Not all couriers support multi-parcel service. For pallet shipments send 0. | 

| 
envelopes | 
integer | 
yes | 
Min 0. | 
Number of envelopes in the shipment. Usually 0. | 

| 
pallets | 
integer | 
no | 
 | 
The number of pallets (used with shipmentType = pallet). | 

| 
totalWeight | 
numeric | 
yes | 
Min 0.01. | 
Total weight of the shipment in kg. The value has to be equal to the sum of all packages. | 

| 
declaredValue | 
numeric | 
no | 
Min 0. | 
Insurance amount of the shipment. The service returns an error when the value is above the permitted maximum for the country. Not all couriers support the service. | 

| 
bankRepayment | 
numeric | 
no | 
Min 0. | 
COD amount of the shipment in local currency. You can set it to 0 or omit it if the shipment doesn't have a COD amount. | 

| 
otherRepayment | 
string | 
no | 
Max 100 characters. | 
Additional information to COD. | 

| 
observations | 
string | 
no | 
Max 100 characters. | 
Additional information about the shipment/products (notes). | 

| 
openPackage | 
boolean | 
no | 
 | 
Check up the shipment before pay. Not supported by all couriers. | 

| 
saturdayDelivery | 
boolean | 
no | 
 | 
Saturday delivery. Not available for some countries. | 

| 
referenceNumber | 
string | 
yes | 
Max 100 characters. **Must be unique to avoid duplicate shipments!** | 
Client reference number. Usually the unique number of the order from your site or an invoice number. Helps for tracking and reporting. | 

| 
products | 
string | 
no | 
Max 1000 characters. | 
The content of the shipment as free text, e.g. product1 product2. | 

| 
fragile | 
boolean | 
no | 
 | 
Marker whether the content is fragile (fragile = 1 if the content is fragile). Used only for BG. | 

| 
productsInfo | 
string | 
no | 
Max 2000 characters. | 
Additional product information. | 

| 
piecesInPack | 
integer | 
no | 
 | 
Products amount in one shipment, e.g. if the shipment contains 5 products the field is filled with 5. | 

**awb.document**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
type | 
string | 
no | 
Enum: invoice | 
Type of the attached document. | 

| 
content | 
base64 string | 
no | 
 | 
PDF content, base64 encoded. | 

| 
format | 
string | 
no | 
Enum: pdf | 
Format of the attached document. | 

**awb.packages**

Optional. If awb.packages (and awb.pallets) are omitted, the system creates one package per parcel with default dimensions 10 x 10 x 20 cm, and totalWeight is spread evenly across the parcels.

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
dimensions.width | 
numeric | 
no | 
Min 0.1. | 
Width of the specific parcel in cm. | 

| 
dimensions.height | 
numeric | 
no | 
Min 0.1. | 
Height of the specific parcel in cm. | 

| 
dimensions.length | 
numeric | 
no | 
Min 0.1. | 
Length of the specific parcel in cm. | 

| 
weight | 
numeric | 
no | 
Min 0.001. | 
Weight of the specific parcel in kg. | 

**products** (top-level array)

Optional. Declares the shipment content as structured items.

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
refNumber | 
string | 
yes | 
 | 
Reference number of the product. | 

| 
qty | 
integer | 
yes | 
Min 1. | 
Quantity of the product. | 

| 
price | 
numeric | 
no | 
 | 
Unit price of the product (with VAT). | 

| 
priceWithoutVat | 
numeric | 
no | 
 | 
Unit price of the product without VAT. | 

**Note:** for senders shipping with Econt or Speedy whose account is configured with a cash receipt, the sum of price x qty over all products must be equal to awb.bankRepayment (when the COD amount is greater than 0), otherwise the request is rejected with a validation error.

**sender**

Optional. Overrides the sender contact data printed on the label / sent to the courier.

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
name | 
string | 
no | 
Max 255 characters. | 
Sender name. | 

| 
phoneNumber | 
string | 
no | 
Max 20 characters. | 
Sender phone number. | 

| 
email | 
string | 
no | 
Valid email. | 
Sender email. | 

| 
econtCODAggrement | 
string | 
no | 
Max 20 characters. | 
Econt COD agreement number. | 

**invoice**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
number | 
string | 
no | 
Max 30 characters. | 
Invoice number. | 

| 
issueDate | 
date | 
no | 
 | 
Invoice issue date. | 

**courierRequest**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
date | 
date string | 
no | 
Must be today or later. | 
The date on which the courier must visit the address. | 

| 
timeFrom | 
time string | 
no | 
Format HH:MM. | 
Starting time of the visit. | 

| 
timeTo | 
time string | 
no | 
Format HH:MM. | 
End time of the visit. | 

**customsData** (legacy, non-EU destinations)

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
dutyPaymentInfo | 
string | 
no | 
Enum: DDU, DDP | 
Mandatory for countries outside the European Union. DDU (Delivery duty unpaid), DDP (Delivery duty paid). | 

| 
customsValue | 
numeric | 
no | 
 | 
Mandatory for countries outside the European Union. | 

For shipments to non-EU destinations a full structured customs declaration (customs_declaration block with products and exportData) can also be sent - see Shipment_Creation_Web_Service_v1.5-NON-EU for the complete field list.

**returnLabel**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
nDaysValid | 
integer | 
no | 
Min 0. Default 0 (no expiry). | 
Number of days the return label is valid. For now used only for Greece. | 

**API Response (Output Fields)**

On success the service returns HTTP 200 with:

| 
**Field** | 
**Description** | 

| 
awb | 
AWB number. | 

| 
id | 
Internal record id of the shipment. Returned only when responseData.id is sent as true. | 

| 
barcode | 
Barcode of the shipment printed on the label. | 

| 
returnLabelNumber | 
Return label number, populated only for couriers that issue a return label as part of the create-shipment call (e.g. Geniki RR number, Zasilkovna return label). Empty for couriers that don't support it. | 

| 
packagesBarcodes | 
Barcodes of the ADDITIONAL packages only (the main label barcode is in barcode). For single-parcel shipments this is an empty array. | 

**Example (3 parcels):**

{
    "awb": 7000008793166,
    "barcode": "7000008793166001F4348",
    "returnLabelNumber": "",
    "packagesBarcodes": [
        "7000008793166002F4348",
        "7000008793166003F4348"
    ]
}

`

**Example (single parcel):**

{
    "awb": 7000008793166,
    "barcode": "7000008793166001F4348",
    "returnLabelNumber": "",
    "packagesBarcodes": []
}

`

On error the response body has the shape:

{
    "error": "error text"
}

`

HTTP Errors:

| 
Code | 
Description | 

| 
200 | 
Returns result from the web service. | 

| 
400 | 
Bad request. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
404 | 
Not found data. | 

| 
422 | 
Unprocessable Entity. Wrong input data. | 

| 
500 | 
Internal Server Error / This action is unauthorized. |

Request body:
```json
{
    "testMode": 0, //On the test environment, all shipments save on test env.
    "senderId": 333, //ID of company, obtain an ID from Companies Web Service or your key account manager.
    "courierId": 20, //ID of courier, obtain an ID from Couriers Web Service. Optional, but recommended.
    "waybillAvailableDate": "2023-06-29", //Dispatch date. Must be between today and 9 days ahead.
    "serviceName": "crossborder", //By default use "crossborder". Service "eushipmentsairexpress" is only for delivery partner "DLH".
    "recipient": {
        "name": "Test User", //Name of recipient or company. Typically, both customer names (first name and last name) or company.
        "countryIsoCode": "HU", //Two-letter uppercase country ISO code. Required without cityId.
        "cityId": 20144281, //The ID of a city where the shipment needs to delivery. Obtain an ID from Cities_Web_Service_v1.0. Using cityId, cityName and zipCode can be null.
        "region": "null", //The Municipality/county where the city is located.
        "cityName": "Balatonszárszó", //City name. If you have your own nomenclature with cities, you can fill in the fields cityName, zipCode and region.
        "zipCode": "8624", //Zip code.
        "streetName": "test street", //Name of the street - e.g. Main street or Main street 10. Optional when officeId or officeCode is sent.
        "buildingNumber": 0, //Number of the street/building - e.g. 10
        "officeId": 1297, //If the courier supports PUDO delivery, you can send the ID of the PUDO. Obtain the PUDO IDs from "Courier_Offices_Web_Service_v1.2"
        "addressText": "additional text, address test", //Additional address information - e.g. bl.25 et. 3 *NOT ALL COURIERS SUPPORT IT*
        "contactPerson": "Test User", //Contact person. Usually is the same as the name of recipient.
        "phoneNumber": "00889000000", //Recipient's phone number - mandatory for all couriers.
        "email": "test@example.com" //Recipient's email - highly recommended. If empty, a placeholder address is substituted.
    },
    "awb": {
        "shipmentType": "pack", //pack or pallet
        "parcels": 1, //Number of parcels in the shipment. *NOT ALL COURIERS SUPPORT MULTIPARCEL SERVICE*
        "envelopes": 0, //Always send "0".
        "totalWeight": 1.000, //Total weight of the shipment in kg. The value has to be equal to the sum of all packages.
        "declaredValue": 0, //Insurance amount of the shipment. *NOT ALL COURIERS SUPPORT THE SERVICE*
        "bankRepayment": 0.0, //COD amount of the shipment in local currency. You can set to 0 if the shipment doesn't have a COD amount.
        "otherRepayment": "additional text for repayment", //The service is no longer supported
        "observations": "notes", //Additional information about the shipment/products. (notes)
        "openPackage": false, //Check up the shipment before pay.
        "shipmentPayer": "sender", //Always "sender"
        "saturdayDelivery": false, //The service is no longer supported
        "referenceNumber": "000000", //Client reference number. Important: The information in the field must be unique to avoid duplicate shipments!
        "products": "test product", //The content of the shipment. e.g. product1 product2
        "fragile": 1, //Marker whether the content is fragile. (fragile = 1 if the content is fragile) - Used only for BG
        "productsInfo": "1111;2222;3333;4444", //Additional product information.
        "piecesInPack": 4, //Products amount in one shipment. e.g If the shipment contain 5 products the field will be filled with 5.
        "packages": {
            "1": {
                "dimensions": {
                    "width": 20,
                    "height": 20,
                    "length": 20
                },
                "weight": 2.300
            }
        }
    },
    "returnLabel": {
        "nDaysValid": 0 //By default is 0 (infinity). Used only for Greece
    }
}
```


---
### Shipment_Creation_Web_Service_v1.5 Pallet

`POST https://api1.inout.bg/api/v1/createAWB`


We can now offer you the ability to ask for a shipment creation directly from your company's software or website by taking advantage of "Shipment Creation". This page describes the creation of PALLET shipments - the endpoint and validation are the same as Shipment_Creation_Web_Service_v1.5, with the pallet-specific fields highlighted below.

Requirements

| 
**API Endpoint** | 
**Description** | 

| 
createAWB | 
Creates a new shipment according to the provided API token and the shipment's data. | 

Method: POST
Authorization: Bearer API_TOKEN

Example URLs

| 
**Environment** | 
**URL** | 

| 
Test | 
https://test-api.inout.bg/api/v1/createAWB | 

| 
Production | 
https://api1.inout.bg/api/v1/createAWB | 

**Pallet specifics**

- Send awb.shipmentType = "pallet".

- Send the number of pallets in awb.pallets and set awb.parcels to 0.

- Describe each pallet in awb.packages with its real dimensions (cm) and weight (kg).

API Call Input Fields
Body (JSON)

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
testMode | 
boolean | 
yes | 
 | 
If you want to use the API only for tests, set this field to true. Applies only to the production environment. On the test environment, all shipments save on test env. | 

| 
senderId (company id) | 
integer | 
yes | 
Must be an existing company ID. | 
ID of company, obtain an ID from Companies Web Service. Please for more information, see Companies Web Service. | 

| 
courierId | 
integer | 
no (recommended) | 
Must be an existing courier ID. | 
ID of courier, obtain an ID from Couriers Web Service. If omitted, the system automatically selects the courier configured for the destination country on your account and returns an error if none is configured. We recommend always sending it explicitly. | 

| 
serviceName | 
string | 
no | 
Must be a service supported by the selected courier. | 
Service name, e.g. crossborder (default) or eushipmentsairexpress. If omitted or not supported by the selected courier, the courier's first available service is used, and otherwise the system default (crossborder). | 

| 
waybillAvailableDate | 
date | 
yes | 
Must be between today and 9 days ahead (format YYYY-MM-DD). | 
The date on which the shipment is to be dispatched. | 

| 
responseData.id | 
boolean | 
no | 
 | 
When set to true, the response also contains the internal record id of the created shipment (field id). | 

| 
courierReturnAWB | 
boolean | 
no | 
 | 
Request a courier return AWB together with the shipment, where the courier supports it (e.g. DHL, Zasilkovna, PPL). | 

**recipient**

Addressing: send EITHER recipient.cityId OR recipient.countryIsoCode + recipient.cityName + (recipient.zipCode OR recipient.region).

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
name | 
string | 
yes | 
Max 100 characters. | 
Name of recipient or company. Typically, both customer names (first name and last name) or a company name are filled in. | 

| 
cityId | 
integer | 
conditional | 
Required when countryIsoCode and cityName are not sent. Must be an existing city ID. | 
The ID of the city where the shipment needs to be delivered. Obtain an ID from the Cities resource. Please for more information, see Cities web service. | 

| 
countryIsoCode | 
string | 
conditional | 
Required without cityId. Two-letter uppercase ISO code, e.g. BG, RO, HU. | 
Two-letter country ISO code of the delivery country. | 

| 
cityName | 
string | 
conditional | 
Required without cityId. Max 100 characters. | 
City name. If you have your own nomenclature with cities, you can fill in the fields cityName, zipCode and region instead of cityId. | 

| 
zipCode | 
string | 
conditional | 
Required without cityId and region. Max 15 characters. | 
Zip code. | 

| 
region | 
string | 
conditional | 
Required without cityId and zipCode. Max 100 characters. Recommended for Romania. | 
Region (county/municipality). | 

| 
officeId | 
integer | 
no | 
Must be an existing office ID. | 
Delivery to a courier office / PUDO / locker: the ID of the office, obtained from Courier_Offices_Web_Service_v1.2. When officeId or officeCode is sent, streetName becomes optional. | 

| 
officeCode | 
string | 
no | 
Must be an existing courier office code. | 
The courier's own office code (field COURIER_OFFICE_CODE in Courier_Offices_Web_Service_v1.2). Alternative to officeId. When either is sent, streetName becomes optional. | 

| 
streetName | 
string | 
conditional | 
Required unless officeId or officeCode is sent. Max 200 characters. | 
Name of the street - e.g. Main street or Main street 10. Legacy option: office delivery can also be requested by adding the keyword "to office: " followed by the office name/address - this is still accepted, but we recommend using officeId or officeCode instead. | 

| 
buildingNumber | 
string or number | 
no | 
Values longer than 8 characters are split: the first 8 characters stay in buildingNumber and the remainder is appended to addressText. | 
Number of the street/building - e.g. 10. | 

| 
addressText | 
string | 
no | 
Max 100 characters. | 
Additional address information - e.g. bl. 25, et. 3. Not all couriers support it. | 

| 
contactPerson | 
string | 
no | 
Max 100 characters. | 
Contact person. Usually the same as the name of the recipient. | 

| 
phoneNumber | 
string | 
yes | 
Max 100 characters. | 
Phone number of the recipient. | 

| 
email | 
string | 
no | 
Not validated. | 
Email of the recipient - highly recommended. If left empty, the system substitutes an internal placeholder address. | 

**awb**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
shipmentType | 
string | 
yes (for pallets) | 
Enum: pack, pallet | 
Send "pallet" for pallet shipments. | 

| 
parcels | 
integer | 
yes | 
Min 0. | 
Number of parcels in the shipment. For pallet shipments send 0. | 

| 
envelopes | 
integer | 
yes | 
Min 0. | 
Number of envelopes in the shipment. Usually 0. | 

| 
pallets | 
integer | 
yes (for pallets) | 
 | 
The number of pallets in the shipment. | 

| 
totalWeight | 
numeric | 
yes | 
Min 0.01. | 
Total weight of the shipment in kg. The value has to be equal to the sum of all packages. | 

| 
declaredValue | 
numeric | 
no | 
Min 0. | 
Insurance amount of the shipment. The service returns an error when the value is above the permitted maximum for the country. Not all couriers support the service. | 

| 
bankRepayment | 
numeric | 
no | 
Min 0. | 
COD amount of the shipment in local currency. You can set it to 0 or omit it if the shipment doesn't have a COD amount. | 

| 
otherRepayment | 
string | 
no | 
Max 100 characters. | 
Additional information to COD. | 

| 
observations | 
string | 
no | 
Max 100 characters. | 
Additional information about the shipment/products (notes). | 

| 
openPackage | 
boolean | 
no | 
 | 
Check up the shipment before pay. Not supported by all couriers. | 

| 
saturdayDelivery | 
boolean | 
no | 
 | 
Saturday delivery. Not available for some countries. | 

| 
referenceNumber | 
string | 
yes | 
Max 100 characters. **Must be unique to avoid duplicate shipments!** | 
Client reference number. Usually the unique number of the order from your site or an invoice number. Helps for tracking and reporting. | 

| 
products | 
string | 
no | 
Max 1000 characters. | 
The content of the shipment as free text, e.g. product1 product2. | 

| 
fragile | 
boolean | 
no | 
 | 
Marker whether the content is fragile (fragile = 1 if the content is fragile). Used only for BG. | 

| 
productsInfo | 
string | 
no | 
Max 2000 characters. | 
Additional product information. | 

| 
piecesInPack | 
integer | 
no | 
 | 
Products amount in one shipment, e.g. if the shipment contains 5 products the field is filled with 5. | 

**awb.document**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
type | 
string | 
no | 
Enum: invoice | 
Type of the attached document. | 

| 
content | 
base64 string | 
no | 
 | 
PDF content, base64 encoded. | 

| 
format | 
string | 
no | 
Enum: pdf | 
Format of the attached document. | 

**awb.packages**

Recommended for pallet shipments - describe each pallet with its real dimensions. If awb.packages and awb.pallets are omitted, the system creates one package per parcel with default dimensions 10 x 10 x 20 cm, and totalWeight is spread evenly across the parcels.

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
dimensions.width | 
numeric | 
no | 
Min 0.1. | 
Width of the specific pallet in cm. | 

| 
dimensions.height | 
numeric | 
no | 
Min 0.1. | 
Height of the specific pallet in cm. | 

| 
dimensions.length | 
numeric | 
no | 
Min 0.1. | 
Length of the specific pallet in cm. | 

| 
weight | 
numeric | 
no | 
Min 0.001. | 
Weight of the specific pallet in kg. | 

**products** (top-level array)

Optional. Declares the shipment content as structured items.

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
refNumber | 
string | 
yes | 
 | 
Reference number of the product. | 

| 
qty | 
integer | 
yes | 
Min 1. | 
Quantity of the product. | 

| 
price | 
numeric | 
no | 
 | 
Unit price of the product (with VAT). | 

| 
priceWithoutVat | 
numeric | 
no | 
 | 
Unit price of the product without VAT. | 

**Note:** for senders shipping with Econt or Speedy whose account is configured with a cash receipt, the sum of price x qty over all products must be equal to awb.bankRepayment (when the COD amount is greater than 0), otherwise the request is rejected with a validation error.

**sender**

Optional. Overrides the sender contact data printed on the label / sent to the courier.

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
name | 
string | 
no | 
Max 255 characters. | 
Sender name. | 

| 
phoneNumber | 
string | 
no | 
Max 20 characters. | 
Sender phone number. | 

| 
email | 
string | 
no | 
Valid email. | 
Sender email. | 

| 
econtCODAggrement | 
string | 
no | 
Max 20 characters. | 
Econt COD agreement number. | 

**invoice**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
number | 
string | 
no | 
Max 30 characters. | 
Invoice number. | 

| 
issueDate | 
date | 
no | 
 | 
Invoice issue date. | 

**courierRequest**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
date | 
date string | 
no | 
Must be today or later. | 
The date on which the courier must visit the address. | 

| 
timeFrom | 
time string | 
no | 
Format HH:MM. | 
Starting time of the visit. | 

| 
timeTo | 
time string | 
no | 
Format HH:MM. | 
End time of the visit. | 

**customsData** (legacy, non-EU destinations)

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
dutyPaymentInfo | 
string | 
no | 
Enum: DDU, DDP | 
Mandatory for countries outside the European Union. DDU (Delivery duty unpaid), DDP (Delivery duty paid). | 

| 
customsValue | 
numeric | 
no | 
 | 
Mandatory for countries outside the European Union. | 

For shipments to non-EU destinations a full structured customs declaration (customs_declaration block with products and exportData) can also be sent - see Shipment_Creation_Web_Service_v1.5-NON-EU for the complete field list.

**returnLabel**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
nDaysValid | 
integer | 
no | 
Min 0. Default 0 (no expiry). | 
Number of days the return label is valid. For now used only for Greece. | 

**API Response (Output Fields)**

On success the service returns HTTP 200 with:

| 
**Field** | 
**Description** | 

| 
awb | 
AWB number. | 

| 
id | 
Internal record id of the shipment. Returned only when responseData.id is sent as true. | 

| 
barcode | 
Barcode of the shipment printed on the label. | 

| 
returnLabelNumber | 
Return label number, populated only for couriers that issue a return label as part of the create-shipment call (e.g. Geniki RR number, Zasilkovna return label). Empty for couriers that don't support it. | 

| 
packagesBarcodes | 
Barcodes of the ADDITIONAL packages only (the main label barcode is in barcode). For single-pallet shipments this is an empty array. | 

**Example:**

{
    "awb": "1507023066",
    "barcode": "1507023066001",
    "returnLabelNumber": "",
    "packagesBarcodes": []
}

`

On error the response body has the shape:

{
    "error": "error text"
}

`

HTTP Errors:

| 
Code | 
Description | 

| 
200 | 
Returns result from the web service. | 

| 
400 | 
Bad request. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
404 | 
Not found data. | 

| 
422 | 
Unprocessable Entity. Wrong input data. | 

| 
500 | 
Internal Server Error / This action is unauthorized. |

Request body:
```json
{
    "serviceName": "crossborder",
    "waybillAvailableDate": "2022-08-30",
    "senderId": "333",
    "courierId": "15",
    "testMode": "0",
    "awb": {
        "shipmentType": "pallet",
        "referenceNumber": "1234567",
        "totalWeight": "100",
        "envelopes": "0",
        "parcels": "0",
        "pallets": "1",
        "declaredValue": 5,
        "observations": null,
        "products": "test test",
        "packages": {
            "1": {
                "dimensions": {
                    "width": "80",
                    "height": "150",
                    "length": "120"
                },
                "weight": "100"
            }
        },
        "bankRepayment": null
    },
    "recipient": {
        "name": "API - TESTS",
        "cityId": null,
        "countryIsoCode": "BG",
        "cityName": "София",
        "zipCode": "1000",
        "region": null,
        "streetName": "ул. Иван Вазов 12",
        "buildingNumber": null,
        "addressText": null,
        "phoneNumber": "0887000000",
        "contactPerson": "API - TESTS",
        "email": "example@example.com"
    },
    "courierRequest": {
        "date": "2022-08-30",
        "timeFrom": "00:00",
        "timeTo": "00:00"
    }
}
```


---
### Shipment_Creation_Web_Service_v1.5-NON-EU

`POST https://api1.inout.bg/api/v1/createAWB`


We can now offer you the ability to ask for a shipment creation directly from your company's software or website by taking advantage of "Shipment Creation". This page describes the creation of shipments to NON-EU destinations - the endpoint and validation are the same as Shipment_Creation_Web_Service_v1.5, plus the customs blocks described below.

Requirements

| 
**API Endpoint** | 
**Description** | 

| 
createAWB | 
Creates a new shipment according to the provided API token and the shipment's data. | 

Method: POST
Authorization: Bearer API_TOKEN

Example URLs

| 
**Environment** | 
**URL** | 

| 
Test | 
https://test-api.inout.bg/api/v1/createAWB | 

| 
Production | 
https://api1.inout.bg/api/v1/createAWB | 

API Call Input Fields
Body (JSON)

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
testMode | 
boolean | 
yes | 
 | 
If you want to use the API only for tests, set this field to true. Applies only to the production environment. On the test environment, all shipments save on test env. | 

| 
senderId (company id) | 
integer | 
yes | 
Must be an existing company ID. | 
ID of company, obtain an ID from Companies Web Service. Please for more information, see Companies Web Service. | 

| 
courierId | 
integer | 
no (recommended) | 
Must be an existing courier ID. | 
ID of courier, obtain an ID from Couriers Web Service. If omitted, the system automatically selects the courier configured for the destination country on your account and returns an error if none is configured. We recommend always sending it explicitly. | 

| 
serviceName | 
string | 
no | 
Must be a service supported by the selected courier. | 
Service name, e.g. crossborder (default) or eushipmentsairexpress. If omitted or not supported by the selected courier, the courier's first available service is used, and otherwise the system default (crossborder). | 

| 
waybillAvailableDate | 
date | 
yes | 
Must be between today and 9 days ahead (format YYYY-MM-DD). | 
The date on which the shipment is to be dispatched. | 

| 
responseData.id | 
boolean | 
no | 
 | 
When set to true, the response also contains the internal record id of the created shipment (field id). | 

| 
courierReturnAWB | 
boolean | 
no | 
 | 
Request a courier return AWB together with the shipment, where the courier supports it (e.g. DHL, Zasilkovna, PPL). | 

**recipient**

Addressing: send EITHER recipient.cityId OR recipient.countryIsoCode + recipient.cityName + (recipient.zipCode OR recipient.region).

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
name | 
string | 
yes | 
Max 100 characters. | 
Name of recipient or company. Typically, both customer names (first name and last name) or a company name are filled in. | 

| 
cityId | 
integer | 
conditional | 
Required when countryIsoCode and cityName are not sent. Must be an existing city ID. | 
The ID of the city where the shipment needs to be delivered. Obtain an ID from the Cities resource. Please for more information, see Cities web service. | 

| 
countryIsoCode | 
string | 
conditional | 
Required without cityId. Two-letter uppercase ISO code, e.g. GB, RS, CH. | 
Two-letter country ISO code of the delivery country. | 

| 
cityName | 
string | 
conditional | 
Required without cityId. Max 100 characters. | 
City name. If you have your own nomenclature with cities, you can fill in the fields cityName, zipCode and region instead of cityId. | 

| 
zipCode | 
string | 
conditional | 
Required without cityId and region. Max 15 characters. | 
Zip code. | 

| 
region | 
string | 
conditional | 
Required without cityId and zipCode. Max 100 characters. | 
Region (county/municipality). | 

| 
officeId | 
integer | 
no | 
Must be an existing office ID. | 
Delivery to a courier office / PUDO / locker: the ID of the office, obtained from Courier_Offices_Web_Service_v1.2. When officeId or officeCode is sent, streetName becomes optional. | 

| 
officeCode | 
string | 
no | 
Must be an existing courier office code. | 
The courier's own office code (field COURIER_OFFICE_CODE in Courier_Offices_Web_Service_v1.2). Alternative to officeId. When either is sent, streetName becomes optional. | 

| 
streetName | 
string | 
conditional | 
Required unless officeId or officeCode is sent. Max 200 characters. | 
Name of the street - e.g. Main street or Main street 10. Legacy option: office delivery can also be requested by adding the keyword "to office: " followed by the office name/address - this is still accepted, but we recommend using officeId or officeCode instead. | 

| 
buildingNumber | 
string or number | 
no | 
Values longer than 8 characters are split: the first 8 characters stay in buildingNumber and the remainder is appended to addressText. | 
Number of the street/building - e.g. 10. | 

| 
addressText | 
string | 
no | 
Max 100 characters. | 
Additional address information - e.g. bl. 25, et. 3. Not all couriers support it. | 

| 
contactPerson | 
string | 
no | 
Max 100 characters. | 
Contact person. Usually the same as the name of the recipient. | 

| 
phoneNumber | 
string | 
yes | 
Max 100 characters. | 
Phone number of the recipient. | 

| 
email | 
string | 
no | 
Not validated. | 
Email of the recipient - highly recommended. If left empty, the system substitutes an internal placeholder address. | 

**awb**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
shipmentType | 
string | 
no | 
Enum: pack, pallet | 
Type of the shipment. Default is pack. | 

| 
parcels | 
integer | 
yes | 
Min 0. | 
Number of parcels in the shipment. Not all couriers support multi-parcel service. | 

| 
envelopes | 
integer | 
yes | 
Min 0. | 
Number of envelopes in the shipment. Usually 0. | 

| 
pallets | 
integer | 
no | 
 | 
The number of pallets (used with shipmentType = pallet). | 

| 
totalWeight | 
numeric | 
yes | 
Min 0.01. | 
Total weight of the shipment in kg. The value has to be equal to the sum of all packages. | 

| 
declaredValue | 
numeric | 
no | 
Min 0. | 
Insurance amount of the shipment. The service returns an error when the value is above the permitted maximum for the country. Not all couriers support the service. | 

| 
bankRepayment | 
numeric | 
no | 
Min 0. | 
COD amount of the shipment in local currency. You can set it to 0 or omit it if the shipment doesn't have a COD amount. | 

| 
otherRepayment | 
string | 
no | 
Max 100 characters. | 
Additional information to COD. | 

| 
observations | 
string | 
no | 
Max 100 characters. | 
Additional information about the shipment/products (notes). | 

| 
openPackage | 
boolean | 
no | 
 | 
Check up the shipment before pay. Not supported by all couriers. | 

| 
saturdayDelivery | 
boolean | 
no | 
 | 
Saturday delivery. Not available for some countries. | 

| 
referenceNumber | 
string | 
yes | 
Max 100 characters. **Must be unique to avoid duplicate shipments!** | 
Client reference number. Usually the unique number of the order from your site or an invoice number. Helps for tracking and reporting. | 

| 
products | 
string | 
no | 
Max 1000 characters. | 
The content of the shipment as free text, e.g. product1 product2. | 

| 
fragile | 
boolean | 
no | 
 | 
Marker whether the content is fragile (fragile = 1 if the content is fragile). Used only for BG. | 

| 
productsInfo | 
string | 
no | 
Max 2000 characters. | 
Additional product information. | 

| 
piecesInPack | 
integer | 
no | 
 | 
Products amount in one shipment, e.g. if the shipment contains 5 products the field is filled with 5. | 

**awb.document**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
type | 
string | 
no | 
Enum: invoice | 
Type of the attached document. | 

| 
content | 
base64 string | 
no | 
 | 
PDF content, base64 encoded (e.g. the commercial invoice). | 

| 
format | 
string | 
no | 
Enum: pdf | 
Format of the attached document. | 

**awb.packages**

Optional. If awb.packages (and awb.pallets) are omitted, the system creates one package per parcel with default dimensions 10 x 10 x 20 cm, and totalWeight is spread evenly across the parcels.

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
dimensions.width | 
numeric | 
no | 
Min 0.1. | 
Width of the specific parcel in cm. | 

| 
dimensions.height | 
numeric | 
no | 
Min 0.1. | 
Height of the specific parcel in cm. | 

| 
dimensions.length | 
numeric | 
no | 
Min 0.1. | 
Length of the specific parcel in cm. | 

| 
weight | 
numeric | 
no | 
Min 0.001. | 
Weight of the specific parcel in kg. | 

**products** (top-level array)

Optional. Declares the shipment content as structured items.

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
refNumber | 
string | 
yes | 
 | 
Reference number of the product. | 

| 
qty | 
integer | 
yes | 
Min 1. | 
Quantity of the product. | 

| 
price | 
numeric | 
no | 
 | 
Unit price of the product (with VAT). | 

| 
priceWithoutVat | 
numeric | 
no | 
 | 
Unit price of the product without VAT. | 

**Note:** for senders shipping with Econt or Speedy whose account is configured with a cash receipt, the sum of price x qty over all products must be equal to awb.bankRepayment (when the COD amount is greater than 0), otherwise the request is rejected with a validation error.

**sender**

Optional. Overrides the sender contact data printed on the label / sent to the courier.

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
name | 
string | 
no | 
Max 255 characters. | 
Sender name. | 

| 
phoneNumber | 
string | 
no | 
Max 20 characters. | 
Sender phone number. | 

| 
email | 
string | 
no | 
Valid email. | 
Sender email. | 

| 
econtCODAggrement | 
string | 
no | 
Max 20 characters. | 
Econt COD agreement number. | 

**invoice**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
number | 
string | 
no | 
Max 30 characters. | 
Invoice number. | 

| 
issueDate | 
date | 
no | 
 | 
Invoice issue date. | 

**courierRequest**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
date | 
date string | 
no | 
Must be today or later. | 
The date on which the courier must visit the address. | 

| 
timeFrom | 
time string | 
no | 
Format HH:MM. | 
Starting time of the visit. | 

| 
timeTo | 
time string | 
no | 
Format HH:MM. | 
End time of the visit. | 

**customs_declaration** (structured customs declaration - recommended for non-EU destinations)

Optional block. When sent, all of its required sub-fields must be present. The declaration is stored together with the shipment and used for the export documents.

**customs_declaration.products** (array, at least 1 item)

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
description | 
string | 
yes | 
Max 255 characters. | 
Description of the goods on this line. | 

| 
taric | 
string | 
yes | 
Max 10 characters. | 
TARIC / HS commodity code of the goods. | 

| 
base_value | 
numeric | 
yes | 
Min 0.01. | 
Customs value of this line. | 

| 
quantity | 
integer | 
yes | 
Min 1. | 
Quantity of the goods on this line. | 

| 
weight | 
integer | 
yes | 
Min 1. | 
Weight of the goods on this line. | 

| 
country_of_origin | 
string | 
yes | 
Two-letter uppercase ISO code. | 
Country of origin of the goods. | 

| 
client_ref | 
string | 
yes | 
Max 100 characters. | 
Your reference for this product line. | 

**customs_declaration.exportData**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
country_of_export | 
string | 
yes | 
Two-letter uppercase ISO code. | 
Country from which the goods are exported. | 

| 
declaration_country | 
string | 
yes | 
Two-letter uppercase ISO code. | 
Country in which the customs declaration is lodged. | 

| 
ioss_number | 
string | 
conditional | 
Max 15 characters. Required whenever customs_declaration is sent, except for courier 805 where it is optional. | 
IOSS number of the seller. | 

If the customs_declaration data fails validation after the shipment is created, the API responds with HTTP 422 and an error message, so always check the response.

**customsData** (legacy customs block - still accepted)

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
dutyPaymentInfo | 
string | 
no | 
Enum: DDU, DDP | 
Mandatory for countries outside the European Union. DDU (Delivery duty unpaid), DDP (Delivery duty paid). | 

| 
customsValue | 
numeric | 
no | 
 | 
Mandatory for countries outside the European Union. | 

**returnLabel**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
nDaysValid | 
integer | 
no | 
Min 0. Default 0 (no expiry). | 
Number of days the return label is valid. For now used only for Greece. | 

**API Response (Output Fields)**

On success the service returns HTTP 200 with:

| 
**Field** | 
**Description** | 

| 
awb | 
AWB number. | 

| 
id | 
Internal record id of the shipment. Returned only when responseData.id is sent as true. | 

| 
barcode | 
Barcode of the shipment printed on the label. | 

| 
returnLabelNumber | 
Return label number, populated only for couriers that issue a return label as part of the create-shipment call (e.g. Geniki RR number, Zasilkovna return label). Empty for couriers that don't support it. | 

| 
packagesBarcodes | 
Barcodes of the ADDITIONAL packages only (the main label barcode is in barcode). For single-parcel shipments this is an empty array. | 

**Example:**

{
    "awb": "1507023066",
    "barcode": "1507023066001",
    "returnLabelNumber": "",
    "packagesBarcodes": []
}

`

On error the response body has the shape:

{
    "error": "error text"
}

`

HTTP Errors:

| 
Code | 
Description | 

| 
200 | 
Returns result from the web service. | 

| 
400 | 
Bad request. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
404 | 
Not found data. | 

| 
422 | 
Unprocessable Entity. Wrong input data. | 

| 
500 | 
Internal Server Error / This action is unauthorized. |

Request body:
```json
{
    "testMode": 0,
    "senderId": 333,
    "courierId": 20,
    "waybillAvailableDate": "2023-01-23",
    "serviceName": "eushipmentsairexpress",
    "recipient": {
        "name": "Test User",
        "countryIsoCode": "HU",
        "cityId": 20144281,
        "region": "null",
        "cityName": "Balatonszárszó",
        "zipCode": "8624",
        "streetName": "test street",
        "buildingNumber": 0,
        "addressText": "additional text, address test",
        "contactPerson": "Test User",
        "phoneNumber": "00889000000",
        "email": "test@example.com"
    },
    "awb": {
        "parcels": 1,
        "envelopes": 0,
        "totalWeight": 1.000,
        "declaredValue": 0,
        "bankRepayment": 0.0,
        "otherRepayment": "additional text for repayment",
        "observations": "notes",
        "openPackage": false,
        "shipmentPayer": "sender",
        "saturdayDelivery": false,
        "referenceNumber": "000000",
        "products": "test product",
        "fragile": 1,
        "productsInfo": "1111;2222;3333;4444",
        "piecesInPack": 4,
        "document": {
            "type": "invoice",
            "content": "JVBERi0xLjcKJcfsj6IKOCAwIG9iago8PC9MZW5ndGggOSAwIFIvRmlsdGVyIC9GbGF0ZURlY29kZT4+CnN0cmVhbQp4nL1bW3fbxhF95++Yc3JO66Tmeu8L6M2SL1EqW44oOy99gUjYpg8vMkg6UU4f0qRu2vSW...",
            "format": "pdf"
        },
        "packages": [
            {
                "dimensions": {
                    "width": 20,
                    "height": 20,
                    "length": 20
                },
                "weight": 1
            }
        ]
    },
    "customs_declaration": {
        "products": [
            {
                "description": "Cotton T-shirt",
                "taric": "6109100010",
                "base_value": 35.50,
                "quantity": 1,
                "weight": 1,
                "country_of_origin": "BG",
                "client_ref": "SKU-000123"
            }
        ],
        "exportData": {
            "country_of_export": "BG",
            "declaration_country": "BG",
            "ioss_number": "IM1234567890123"
        }
    },
    "customsData": {
        "dutyPaymentInfo": "DDU",
        "customsValue": 35.50
    }
}
```


---
### Pickup_AWB_Creation_Web_Service-v1.0

`POST https://api1.inout.bg/api/v1/awb/pickup`


We can now offer you the ability to create a pickup request for a shipment directly from your company's software or website by taking advantage of "Pickup AWB Creation".

Requirements

| 
**API Endpoint** | 
**Description** | 

| 
/awb/pickup | 
Creating a pickup AWB in our system via API. | 

Method: POST
Authorization: Bearer API_TOKEN

Example URLs

| 
**Environment** | 
**URL** | 

| 
Test | 
https://test-api.inout.bg/api/v1/awb/pickup | 

| 
Production | 
https://api1.inout.bg/api/v1/awb/pickup | 

API Call Input Fields
Body (JSON)

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
companyId | 
integer | 
yes | 
There must be a company with the selected ID. | 
ID of company, you can receive it from the Companies Web Service. | 

| 
courierId | 
integer | 
yes | 
There must be a courier with the selected ID. | 
ID of courier, you can receive it from the Couriers Web Service. Always required for pickup AWBs. | 

**sender**

Addressing: send EITHER sender.cityId OR sender.countryIsoCode + sender.cityName + (sender.zipCode OR sender.region).

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
name | 
string | 
yes | 
Max 100 characters. | 
Name of sender or company. Typically, both sender names (first name and last name) or a company name are filled in. | 

| 
cityId | 
integer | 
conditional | 
Required when countryIsoCode and cityName are not sent. Must be an existing city ID. | 
The ID of the city from which the shipment will be picked up. Obtain an ID from the Cities resource. Please for more information, see Cities web service. | 

| 
countryIsoCode | 
string | 
conditional | 
Required without cityId. Two-letter uppercase ISO code, e.g. BG, HU. | 
Two-letter country ISO code of the pickup country. | 

| 
cityName | 
string | 
conditional | 
Required without cityId. Max 100 characters. | 
Sender's city name, e.g. Sofia. | 

| 
zipCode | 
string | 
conditional | 
Required without cityId and region. Max 15 characters. | 
Sender's city zip code, e.g. 1000. | 

| 
region | 
string | 
conditional | 
Required without cityId and zipCode. Max 100 characters. Recommended for Romania. | 
Sender's region. | 

| 
officeId | 
integer | 
no | 
Must be an existing office ID. | 
Pickup from a courier office / PUDO: the ID of the office from Courier_Offices_Web_Service_v1.2. When officeId or officeCode is sent, streetName becomes optional. | 

| 
officeCode | 
string | 
no | 
Must be an existing courier office code. | 
The courier's own office code. Alternative to officeId. When either is sent, streetName becomes optional. | 

| 
streetName | 
string | 
conditional | 
Required unless officeId or officeCode is sent. Max 200 characters. | 
Name of the street of the pickup address - e.g. Main street or Main street 10. | 

| 
contactPerson | 
string | 
no | 
Max 100 characters. | 
Contact person. Usually the same as the name of the sender. | 

| 
phoneNumber | 
string | 
yes | 
Max 100 characters. | 
Sender's phone number. | 

| 
email | 
string | 
yes | 
Must be a valid email address. | 
Sender's email. | 

**awb**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
parcels | 
integer | 
yes | 
Must be exactly 1. | 
Number of parcels in the pickup shipment. Only single-parcel pickups are supported. | 

| 
totalWeight | 
numeric | 
yes | 
Min 0.01. | 
Total weight of the shipment in kg. | 

| 
observations | 
string | 
no | 
Max 100 characters. | 
Additional information about the shipment/products (notes). | 

| 
referenceNumber | 
string | 
yes | 
Max 100 characters. **Must be unique!** | 
Client reference number. Usually the unique number of the pickup request from your system. Helps for tracking and reporting. | 

| 
products | 
string | 
no | 
Max 1000 characters. | 
The content of the shipment, e.g. product1 product2. | 

**awb.packages**

Optional array.

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
dimensions.width | 
numeric | 
no | 
Min 0.1. | 
Package width in cm. | 

| 
dimensions.height | 
numeric | 
no | 
Min 0.1. | 
Package height in cm. | 

| 
dimensions.length | 
numeric | 
no | 
Min 0.1. | 
Package length in cm. | 

| 
weight | 
numeric | 
no | 
Min 0.001. | 
Package weight in kg. | 

**API Response (Output Fields)**

On success the service returns HTTP 200 with:

| 
**Field** | 
**Description** | 

| 
pickupAWBNumber | 
Pickup AWB number. | 

| 
id | 
Internal record id of the pickup AWB. | 

| 
lockerCode | 
The courier's pickup-order / locker code, or null when not applicable. | 

**Example:**

{
    "pickupAWBNumber": "3169951776",
    "id": 12345678,
    "lockerCode": null
}

`

**Important:** most runtime errors (courier rejection, duplicate reference number, partner API not responding, etc.) are returned with HTTP 200 and a body of the shape below. Always check the response body for an "error" key, even when the HTTP status is 200.

{
    "error": "error text"
}

`

Validation failures return HTTP 422.

HTTP Errors:

| 
Code | 
Description | 

| 
200 | 
Returns result from the web service - either the created pickup AWB or an error object (check for the "error" key). | 

| 
400 | 
Bad request. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
404 | 
Not found record. | 

| 
422 | 
Unprocessable Entity. Wrong input data. | 

| 
500 | 
Internal Server Error / This action is unauthorized. |

Request body:
```json
{
    "companyId": 333,
    "courierId": 20,
    "sender": {
        "name": "TEST API",
        "cityId": 20142210,
        "countryIsoCode": "HU",
        "cityName": null,
        "zipCode": null,
        "region": null,
        "streetName": "Nagymező u.",
        "contactPerson": "TEST API",
        "phoneNumber": "+3655237191",
        "email": "test@example.com"
    },
    "awb": {
        "parcels": 1,
        "totalWeight": 1,
        "observations": null,
        "products": "test products",
        "referenceNumber": "PICKUP-000001",
        "packages": [
            {
                "dimensions": {
                    "width": 10,
                    "height": 10,
                    "length": 10
                },
                "weight": 1
            }
        ]
    }
}
```


---
### PDF_Web_Service_v1.2

`GET https://api1.inout.bg/api/v1/print/{AWBnumber}?testMode=0`


We can now offer you the ability to ask for a shipping label directly from your company's software or website by taking advantage of "PDF Web Service".

**Requirements:**

| 
**API Endpoint** | 
**Description** | 

| 
print/{AWBnumber} | 
Get the shipping label as a PDF file (A4 or label format, base64 encoded) or as a raw ZPL string. | 

**Method: GET**
**Authorization: Bearer API_TOKEN**

**API Call Input Fields**
**URL query parameters**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
testMode | 
boolean | 
yes | 
 | 
If you want to use the API only for tests set this field to true. Applies only to the production environment. On the test environment, all shipments save on test env. | 

| 
printFileType | 
smallInt | 
no | 
Allowed values: 1, 2, 3. Default: 2 | 
Choose the print format:
1 = PDF in A4 format;
2 = PDF in label format (default when the parameter is omitted);
3 = raw ZPL (Zebra Programming Language) label.
A4/label formats work only if the courier also supports the waybill in both formats. Important: if a specific label type is configured for your account in our system, you receive the PDF in the format configured in our system.
ZPL (printFileType=3) is available only for couriers that provide a ZPL label; for all other couriers the service returns an error. | 

**Notes:**

- For multi-parcel shipments only the label of the MAIN package can be requested. Requesting the AWB number of a secondary parcel returns HTTP 422 with the error "Additional package detected. Please print the main package instead."

- If the number you pass is an InOut pre-AWB label number (an InOut label created before the courier AWB exists), the InOut label is returned instead of a courier label.

**Example URLs:**

Test: https://test-api.inout.bg/api/v1/print/64506083?testMode=1
Production: https://api1.inout.bg/api/v1/print/64506083?testMode=0

**API Response (Output Fields)**

| 
**Field** | 
**Description** | 

| 
type | 
Document type: "PDF" or "ZPL". | 

| 
awb_print | 
For type "PDF" - the base64 encoded PDF file. For type "ZPL" - the raw ZPL string (not base64 encoded). | 

Example (PDF):

{
    "type": "PDF",
    "awb_print": "JVBERi0xLjQKJ... (base64 encoded PDF)"
}

`

Example (ZPL, printFileType=3):

{
    "type": "ZPL",
    "awb_print": "^XA^CI28... (raw ZPL string)"
}

`

**HTTP Errors:**

| 
**Code** | 
**Description** | 

| 
200 | 
Returns result from the web service. | 

| 
400 | 
Bad request. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
404 | 
Not found data. | 

| 
408 | 
The partner API did not answer. Please try again later! | 

| 
422 | 
Unprocessable Entity. Wrong input data. / Additional package detected. Please print the main package instead. / ZPL not available for this courier. | 

| 
500 | 
Internal Server Error / This action is unauthorized. |


---
### Waybills_History_Web_Service-v1.0

`POST https://api1.inout.bg/api/v1/fulfilment/waybills-history`


We can now offer you the ability to get the statuses history for a list of AWB numbers directly from your company's software or website by taking advantage of "Waybills History Web Service".

**Requirements**

| 
**API Endpoint** | 
**Description** | 

| 
/fulfilment/waybills-history | 
Receive the statuses history for up to 100 AWB numbers in one request. The lookup is strictly BY AWB NUMBER (the shipment number returned at AWB creation), not by order reference number. | 

**Method: POST**
**Authorization: Bearer API_TOKEN**

**API Call Input Fields**
**Body (JSON)**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
testMode | 
boolean | 
yes | 
 | 
If you want to use the API only for tests set this field to true. Applies only to the production environment. On the test environment, all shipments save on test env. | 

| 
awbs | 
array of objects | 
yes | 
max 100 AWB's per request | 
List of the AWB numbers you want to check. | 

| 
awb | 
string | 
yes | 
Must exist in our DB and must be created with your API Token | 
Shipment number (AWB). | 

**Example:**

{
    "testMode": 0,
    "awbs": [
        {
            "awb": "321654987456"
        },
        {
            "awb": "321654123456"
        },
        {
            "awb": "987654321"
        },
        {
            "awb": "654321897654"
        }
    ]
}

`

**Example URLs:**

Test: https://test-api.inout.bg/api/v1/fulfilment/waybills-history
Production: https://api1.inout.bg/api/v1/fulfilment/waybills-history

**API Response (Output Fields)**

The service returns an array with one entry per requested AWB, in the same order as the request.

| 
**Field** | 
**Description** | 

| 
refNum | 
Your order reference number - the value you sent in "referenceNumber" when the AWB was created. Null in not-found entries. | 

| 
awb | 
The AWB number from your request. | 

| 
newReturnNumber | 
The return AWB number, if a return shipment was generated for this AWB. Null if no return shipment exists. | 

| 
courierId | 
The ID of the last-mile courier delivering the shipment. | 

| 
courierName | 
The name of the last-mile courier delivering the shipment. | 

| 
error | 
Text of a possible error for this AWB (e.g. AWB not found or not accessible with your API token). Null when the AWB was found. | 

| 
errorCode | 
Error code for this AWB, if any (e.g. 404 when the AWB was not found). Null when the AWB was found. | 

| 
statusesHistory | 
Array with the statuses history. Empty array when the AWB was not found. | 

**StatusesHistory (Data Structure)**

| 
**Field** | 
**Description** | 

| 
ID | 
Record identifier. | 

| 
STATUS | 
Status text (e.g. In transit, On delivery etc.). | 

| 
DATE | 
The moment the status occurred at the courier (courier event time). The history is ordered by this field. | 

| 
DATE_CREATED | 
The date when the record was stored in the euShipments system. | 

| 
COMMENT | 
The name of the status in the native language for every country. | 

**Shipment statuses** (current as of July 2026, generated from the live system):

| 
**ID** | 
**Status** | 
**Final Status** | 

| 
1 | 
On delivery | 
No | 

| 
2 | 
In transit | 
No | 

| 
3 | 
Delivered | 
Yes | 

| 
4 | 
Returned | 
Yes | 

| 
5 | 
In the office | 
No | 

| 
6 | 
COD paid | 
Yes | 

| 
7 | 
New | 
No | 

| 
8 | 
Cancelled | 
Yes | 

| 
11 | 
Stockout | 
No | 

| 
13 | 
Lost shipment | 
Yes | 

| 
14 | 
Redirected | 
No | 

| 
15 | 
Deleted | 
Yes | 

| 
16 | 
Warehouse Ruse | 
No | 

| 
17 | 
Returning | 
No | 

| 
18 | 
Scanned Waybill | 
No | 

| 
19 | 
Packed | 
No | 

| 
20 | 
Information received | 
No | 

| 
21 | 
Awaiting pickup | 
No | 

| 
22 | 
Insufficient data - AWB not created | 
No | 

| 
23 | 
Information sent to warehouse | 
No | 

| 
24 | 
Compensation paid | 
Yes | 

| 
25 | 
Claim opened | 
Yes | 

| 
26 | 
Warehouse | 
No | 

| 
27 | 
Damaged shipment | 
Yes | 

| 
28 | 
PreAlert | 
No | 

| 
29 | 
Destroyed | 
Yes | 

| 
30 | 
Warehouse Budapest | 
No | 

| 
31 | 
Lastmile Accept | 
No | 

| 
32 | 
Warehouse Sofia | 
No | 

| 
33 | 
Warehouse Zagreb | 
No | 

| 
34 | 
Returned to Warehouse | 
Yes | 

| 
35 | 
Rejected by courier | 
Yes | 

| 
36 | 
Returned to Client | 
Yes | 

| 
37 | 
Оn hold | 
No | 

| 
38 | 
Cancel | 
No | 

| 
39 | 
Warehouse Oradea | 
No | 

| 
40 | 
Wrong recipient data | 
No | 

| 
41 | 
Linhaul transit | 
No | 

| 
42 | 
Product returned to stock | 
Yes | 

| 
43 | 
Insufficient data | 
No | 

| 
44 | 
Unsuccessful delivery attempt | 
No | 

| 
45 | 
Warehouse Senec | 
No | 

| 
46 | 
Warehouse Budapest E | 
No | 

| 
47 | 
Warehouse Pickup | 
No | 

| 
48 | 
Warehouse Webshippy | 
No | 

| 
49 | 
Linehaul loading | 
No | 

| 
50 | 
Warehouse Ljubljana | 
No | 

| 
51 | 
Picked up | 
No | 

| 
52 | 
Search cancelled | 
No | 

| 
53 | 
Underaudit | 
No | 

| 
54 | 
COD Blocked by Authorities | 
No | 

| 
55 | 
Loaded hub Ruse (BG) | 
No | 

| 
56 | 
Loaded hub Sofia (BG) | 
No | 

| 
57 | 
Loaded hub Oradea (RO) | 
No | 

| 
58 | 
Loaded hub Zagreb (HR) | 
No | 

| 
59 | 
Loaded hub Senec (SK) | 
No | 

| 
60 | 
Unloaded hub Ruse (BG) | 
No | 

| 
61 | 
Unloaded hub Sofia (BG) | 
No | 

| 
62 | 
Unloaded hub Oradea (RO) | 
No | 

| 
63 | 
Unloaded hub Zagreb (HR) | 
No | 

| 
64 | 
Unloaded hub Senec (SK) | 
No | 

| 
65 | 
Loaded hub Ljubljana (SI) | 
No | 

| 
66 | 
Unloaded hub Ljubljana (SI) | 
No | 

| 
67 | 
Under investigation | 
No | 

| 
68 | 
Warehouse Bolzano | 
No | 

| 
69 | 
Loaded hub Bolzano (IT) | 
No | 

| 
70 | 
Unloaded hub Bolzano (IT) | 
No | 

| 
71 | 
Warehouse Castellbisbal | 
No | 

| 
72 | 
Loaded hub Castellbisbal (ES) | 
No | 

| 
73 | 
Unloaded hub Castellbisbal (ES) | 
No | 

| 
74 | 
Repackaged | 
No | 

| 
75 | 
Warehouse Burgas | 
No | 

| 
76 | 
Loaded hub Burgas (BG) | 
No | 

| 
77 | 
Unloaded hub Burgas (BG) | 
No | 

| 
78 | 
Loaded hub Buda (HU) | 
No | 

| 
79 | 
Unloaded hub Buda (HU) | 
No | 

| 
80 | 
Warehouse Vienna | 
No | 

| 
81 | 
Loaded hub Vienna (AT) | 
No | 

| 
82 | 
Unloaded hub Vienna (AT) | 
No | 

| 
86 | 
Warehouse Montana | 
No | 

| 
87 | 
Loaded hub Montana (BG) | 
No | 

| 
88 | 
Unloaded hub Montana (BG) | 
No | 

| 
89 | 
Warehouse Istanbul | 
No | 

| 
90 | 
Loaded hub Istanbul (TR) | 
No | 

| 
91 | 
Unloaded hub Istanbul (TR) | 
No | 

| 
92 | 
Loaded hub Budapest (HU) | 
No | 

| 
93 | 
Unloaded hub Budapest (HU) | 
No | 

**Example:**

[
  {
    "refNum": "5420122",
    "awb": "00228876896",
    "newReturnNumber": null,
    "courierId": 746,
    "courierName": "InPost PL",
    "error": null,
    "errorCode": null,
    "statusesHistory": [
      {
        "ID": 26332,
        "STATUS": "Information received",
        "DATE": "2020-03-06 10:47:18",
        "DATE_CREATED": "2020-03-06 10:47:18",
        "COMMENT": null
      }
    ]
  },
  {
    "refNum": null,
    "awb": "55555555555555555555",
    "error": "Not found waybill with the specified waybill number!",
    "errorCode": 404,
    "statusesHistory": []
  }
]

`

Note: an AWB that does not exist in our DB or was not created with your API token is NOT an HTTP error - the request still returns HTTP 200 and the entry for that AWB contains the "error" and "errorCode" fields as shown above.

**HTTP Errors:**

| 
**Code** | 
**Description** | 

| 
200 | 
The request was successful (including entries with per-AWB "error" fields). | 

| 
400 | 
Bad request. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
500 | 
{"error": "Missing testMode parameter!"} - the testMode parameter is missing from the body. | 

| 
500 | 
{"error": "Missing awbs parameter!"} - the awbs parameter is missing from the body. | 

| 
500 | 
{"error": "You can enter maximum 100 waybills!"} - more than 100 AWBs were sent in one request. | 

| 
500 | 
Internal Server Error / This action is unauthorized. |

Request body:
```json
{
	"testMode": 0,
	"awbs": [
		{
			"awb": "321654987456"
		}, 
		{
			"awb": "321654123456"
		},
		{
			"awb": "987654321"
		},
		{
			"awb": "654321897654"
		}
	]
}
```


---
### Shipment_Status_Web_Service_v1.1

`GET https://api1.inout.bg/api/v1/get-status/{AWBNumber}?testMode=0`


We can now offer you the ability to ask for the last shipment status directly from your company's software or website by taking advantage of "Shipment Status Web Service".

**Requirements:**

| 
**API Endpoint** | 
**Description** | 

| 
get-status/{AWBNumber} | 
Receive the last shipment status. | 

**Method: GET**
**Authorization: Bearer API_TOKEN**

**API Call Input Fields**
**URL query parameters**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
testMode | 
boolean | 
yes | 
 | 
If you want to use the API only for tests set this field to true. Applies only to the production environment. On the test environment, all shipments save on test env. | 

**Example URLs:**

Test: https://test-api.inout.bg/api/v1/get-status/64506083?testMode=1
Production: https://api1.inout.bg/api/v1/get-status/64506083?testMode=0

**API Response (Output Fields)**

| 
**Field** | 
**Description** | 

| 
status | 
Text with the last status from the shipment tracking. | 

Example:

{
    "status": "Delivered"
}

`

**Special value:** if the AWB has been deleted/cancelled in our system, the service still responds with HTTP 200 and returns:

{
    "status": "canceled/deleted"
}

`

**Shipment statuses** (current as of July 2026, generated from the live system):

| 
**ID** | 
**Status** | 
**Final Status** | 

| 
1 | 
On delivery | 
No | 

| 
2 | 
In transit | 
No | 

| 
3 | 
Delivered | 
Yes | 

| 
4 | 
Returned | 
Yes | 

| 
5 | 
In the office | 
No | 

| 
6 | 
COD paid | 
Yes | 

| 
7 | 
New | 
No | 

| 
8 | 
Cancelled | 
Yes | 

| 
11 | 
Stockout | 
No | 

| 
13 | 
Lost shipment | 
Yes | 

| 
14 | 
Redirected | 
No | 

| 
15 | 
Deleted | 
Yes | 

| 
16 | 
Warehouse Ruse | 
No | 

| 
17 | 
Returning | 
No | 

| 
18 | 
Scanned Waybill | 
No | 

| 
19 | 
Packed | 
No | 

| 
20 | 
Information received | 
No | 

| 
21 | 
Awaiting pickup | 
No | 

| 
22 | 
Insufficient data - AWB not created | 
No | 

| 
23 | 
Information sent to warehouse | 
No | 

| 
24 | 
Compensation paid | 
Yes | 

| 
25 | 
Claim opened | 
Yes | 

| 
26 | 
Warehouse | 
No | 

| 
27 | 
Damaged shipment | 
Yes | 

| 
28 | 
PreAlert | 
No | 

| 
29 | 
Destroyed | 
Yes | 

| 
30 | 
Warehouse Budapest | 
No | 

| 
31 | 
Lastmile Accept | 
No | 

| 
32 | 
Warehouse Sofia | 
No | 

| 
33 | 
Warehouse Zagreb | 
No | 

| 
34 | 
Returned to Warehouse | 
Yes | 

| 
35 | 
Rejected by courier | 
Yes | 

| 
36 | 
Returned to Client | 
Yes | 

| 
37 | 
Оn hold | 
No | 

| 
38 | 
Cancel | 
No | 

| 
39 | 
Warehouse Oradea | 
No | 

| 
40 | 
Wrong recipient data | 
No | 

| 
41 | 
Linhaul transit | 
No | 

| 
42 | 
Product returned to stock | 
Yes | 

| 
43 | 
Insufficient data | 
No | 

| 
44 | 
Unsuccessful delivery attempt | 
No | 

| 
45 | 
Warehouse Senec | 
No | 

| 
46 | 
Warehouse Budapest E | 
No | 

| 
47 | 
Warehouse Pickup | 
No | 

| 
48 | 
Warehouse Webshippy | 
No | 

| 
49 | 
Linehaul loading | 
No | 

| 
50 | 
Warehouse Ljubljana | 
No | 

| 
51 | 
Picked up | 
No | 

| 
52 | 
Search cancelled | 
No | 

| 
53 | 
Underaudit | 
No | 

| 
54 | 
COD Blocked by Authorities | 
No | 

| 
55 | 
Loaded hub Ruse (BG) | 
No | 

| 
56 | 
Loaded hub Sofia (BG) | 
No | 

| 
57 | 
Loaded hub Oradea (RO) | 
No | 

| 
58 | 
Loaded hub Zagreb (HR) | 
No | 

| 
59 | 
Loaded hub Senec (SK) | 
No | 

| 
60 | 
Unloaded hub Ruse (BG) | 
No | 

| 
61 | 
Unloaded hub Sofia (BG) | 
No | 

| 
62 | 
Unloaded hub Oradea (RO) | 
No | 

| 
63 | 
Unloaded hub Zagreb (HR) | 
No | 

| 
64 | 
Unloaded hub Senec (SK) | 
No | 

| 
65 | 
Loaded hub Ljubljana (SI) | 
No | 

| 
66 | 
Unloaded hub Ljubljana (SI) | 
No | 

| 
67 | 
Under investigation | 
No | 

| 
68 | 
Warehouse Bolzano | 
No | 

| 
69 | 
Loaded hub Bolzano (IT) | 
No | 

| 
70 | 
Unloaded hub Bolzano (IT) | 
No | 

| 
71 | 
Warehouse Castellbisbal | 
No | 

| 
72 | 
Loaded hub Castellbisbal (ES) | 
No | 

| 
73 | 
Unloaded hub Castellbisbal (ES) | 
No | 

| 
74 | 
Repackaged | 
No | 

| 
75 | 
Warehouse Burgas | 
No | 

| 
76 | 
Loaded hub Burgas (BG) | 
No | 

| 
77 | 
Unloaded hub Burgas (BG) | 
No | 

| 
78 | 
Loaded hub Buda (HU) | 
No | 

| 
79 | 
Unloaded hub Buda (HU) | 
No | 

| 
80 | 
Warehouse Vienna | 
No | 

| 
81 | 
Loaded hub Vienna (AT) | 
No | 

| 
82 | 
Unloaded hub Vienna (AT) | 
No | 

| 
86 | 
Warehouse Montana | 
No | 

| 
87 | 
Loaded hub Montana (BG) | 
No | 

| 
88 | 
Unloaded hub Montana (BG) | 
No | 

| 
89 | 
Warehouse Istanbul | 
No | 

| 
90 | 
Loaded hub Istanbul (TR) | 
No | 

| 
91 | 
Unloaded hub Istanbul (TR) | 
No | 

| 
92 | 
Loaded hub Budapest (HU) | 
No | 

| 
93 | 
Unloaded hub Budapest (HU) | 
No | 

**HTTP Errors**

| 
**Code** | 
**Description** | 

| 
200 | 
Returns result from the web service. | 

| 
400 | 
Bad request. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
422 | 
{"error": "AWB not found. Please check testMode param and awb number."} - the AWB number does not exist (or is not visible with the given testMode). Note: an unknown AWB returns 422, not 404. | 

| 
500 | 
Internal Server Error / This action is unauthorized. |


---
### Shipment_History_Web_Service_v1.4

`GET https://api1.inout.bg/api/v1/get-status/history/{AWBNumber}?testMode=0&lang=EN`


We can now offer you the ability to ask for the full shipment history directly from your company's software or website by taking advantage of "Shipment History Web Service".

**Requirements:**

| 
**API Endpoint** | 
**Description** | 

| 
get-status/history/{AWBNumber} | 
Receive all statuses from the shipment tracking. | 

**Method: GET**
**Authorization: Bearer API_TOKEN**

**API Call Input Fields**
**URL query parameters**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
testMode | 
boolean | 
yes | 
 | 
If you want to use the API only for tests set this field to true. Applies only to the production environment. On the test environment, all shipments save on test env. | 

| 
lang | 
string | 
no | 
Language initials, e.g. 'EN' | 
If you want to receive the courier statuses translated in the "COMMENT" field, fill this field with the language initials, e.g. 'EN'. If no translation exists for a given status and language, "COMMENT" contains the courier's original text in its native language. | 

**Example URLs:**

Test: https://test-api.inout.bg/api/v1/get-status/history/64506083?testMode=1&lang=EN
Production: https://api1.inout.bg/api/v1/get-status/history/64506083?testMode=0&lang=EN

**API Response (Output Fields)**

| 
**Field** | 
**Description** | 

| 
statusesHistory | 
An array of objects with all statuses up to this moment, ordered by the DATE field (courier event time), ascending. | 

| 
ID | 
An ID of the status record. | 

| 
STATUS | 
The shipment status in our system. | 

| 
DATE | 
The moment the status occurred at the courier (courier event time). The history is ordered by this field. | 

| 
DATE_CREATED | 
The date when the record was stored in the euShipments system. | 

| 
COMMENT | 
The name of the status in the native language for every country (or translated, if the "lang" parameter is used and a translation exists). | 

| 
PARTNER_VOUCHER | 
Voucher number for the partner. | 

| 
NOTE_ID | 
Internal ID of the courier status/note record, set if the courier has an additional note to the shipment. | 

| 
NOTE_CODE | 
The courier's own status/reason code, when the courier provides one. | 

Example:

{
  "statusesHistory": [
    {
      "ID": 2513944,
      "STATUS": "New",
      "DATE": "2019-11-05 13:02:38",
      "DATE_CREATED": "2019-11-05 15:00:58",
      "COMMENT": "NEW",
      "PARTNER_VOUCHER": null,
      "NOTE_ID": null,
      "NOTE_CODE": null
    },
    {
      "ID": 2515304,
      "STATUS": "Warehouse Ruse",
      "DATE": "2019-11-05 16:54:14",
      "DATE_CREATED": "2019-11-05 16:54:14",
      "COMMENT": null,
      "PARTNER_VOUCHER": null,
      "NOTE_ID": null,
      "NOTE_CODE": null
    },
    {
      "ID": 2516372,
      "STATUS": "In transit",
      "DATE": "2019-11-05 18:01:06",
      "DATE_CREATED": "2019-11-05 18:01:06",
      "COMMENT": "ONROAD",
      "PARTNER_VOUCHER": null,
      "NOTE_ID": null,
      "NOTE_CODE": null
    },
    {
      "ID": 2770453,
      "STATUS": "In transit",
      "DATE": "2019-12-17 20:20:23",
      "DATE_CREATED": "2019-12-17 20:20:23",
      "COMMENT": "ONROAD - УГОВОРКА ЗА БЪДЕЩА ДОСТАВКА",
      "PARTNER_VOUCHER": null,
      "NOTE_ID": 45,
      "NOTE_CODE": "MF"
    },
    {
      "ID": 2776573,
      "STATUS": "In transit",
      "DATE": "2019-12-18 10:52:16",
      "DATE_CREATED": "2019-12-18 10:52:16",
      "COMMENT": "ONROAD - УГОВОРКА ЗА БЪДЕЩА ДОСТАВКА",
      "PARTNER_VOUCHER": null,
      "NOTE_ID": 45,
      "NOTE_CODE": "MF"
    }
  ]
}

`

**Notes:**

- If the AWB has been deleted in our system, the service still responds with HTTP 200 and the history is returned with a final "Deleted" entry.

- An unknown AWB number returns HTTP 422 (see HTTP Errors below), not 404.

**Shipment statuses** (current as of July 2026, generated from the live system):

| 
**ID** | 
**Status** | 
**Final Status** | 

| 
1 | 
On delivery | 
No | 

| 
2 | 
In transit | 
No | 

| 
3 | 
Delivered | 
Yes | 

| 
4 | 
Returned | 
Yes | 

| 
5 | 
In the office | 
No | 

| 
6 | 
COD paid | 
Yes | 

| 
7 | 
New | 
No | 

| 
8 | 
Cancelled | 
Yes | 

| 
11 | 
Stockout | 
No | 

| 
13 | 
Lost shipment | 
Yes | 

| 
14 | 
Redirected | 
No | 

| 
15 | 
Deleted | 
Yes | 

| 
16 | 
Warehouse Ruse | 
No | 

| 
17 | 
Returning | 
No | 

| 
18 | 
Scanned Waybill | 
No | 

| 
19 | 
Packed | 
No | 

| 
20 | 
Information received | 
No | 

| 
21 | 
Awaiting pickup | 
No | 

| 
22 | 
Insufficient data - AWB not created | 
No | 

| 
23 | 
Information sent to warehouse | 
No | 

| 
24 | 
Compensation paid | 
Yes | 

| 
25 | 
Claim opened | 
Yes | 

| 
26 | 
Warehouse | 
No | 

| 
27 | 
Damaged shipment | 
Yes | 

| 
28 | 
PreAlert | 
No | 

| 
29 | 
Destroyed | 
Yes | 

| 
30 | 
Warehouse Budapest | 
No | 

| 
31 | 
Lastmile Accept | 
No | 

| 
32 | 
Warehouse Sofia | 
No | 

| 
33 | 
Warehouse Zagreb | 
No | 

| 
34 | 
Returned to Warehouse | 
Yes | 

| 
35 | 
Rejected by courier | 
Yes | 

| 
36 | 
Returned to Client | 
Yes | 

| 
37 | 
Оn hold | 
No | 

| 
38 | 
Cancel | 
No | 

| 
39 | 
Warehouse Oradea | 
No | 

| 
40 | 
Wrong recipient data | 
No | 

| 
41 | 
Linhaul transit | 
No | 

| 
42 | 
Product returned to stock | 
Yes | 

| 
43 | 
Insufficient data | 
No | 

| 
44 | 
Unsuccessful delivery attempt | 
No | 

| 
45 | 
Warehouse Senec | 
No | 

| 
46 | 
Warehouse Budapest E | 
No | 

| 
47 | 
Warehouse Pickup | 
No | 

| 
48 | 
Warehouse Webshippy | 
No | 

| 
49 | 
Linehaul loading | 
No | 

| 
50 | 
Warehouse Ljubljana | 
No | 

| 
51 | 
Picked up | 
No | 

| 
52 | 
Search cancelled | 
No | 

| 
53 | 
Underaudit | 
No | 

| 
54 | 
COD Blocked by Authorities | 
No | 

| 
55 | 
Loaded hub Ruse (BG) | 
No | 

| 
56 | 
Loaded hub Sofia (BG) | 
No | 

| 
57 | 
Loaded hub Oradea (RO) | 
No | 

| 
58 | 
Loaded hub Zagreb (HR) | 
No | 

| 
59 | 
Loaded hub Senec (SK) | 
No | 

| 
60 | 
Unloaded hub Ruse (BG) | 
No | 

| 
61 | 
Unloaded hub Sofia (BG) | 
No | 

| 
62 | 
Unloaded hub Oradea (RO) | 
No | 

| 
63 | 
Unloaded hub Zagreb (HR) | 
No | 

| 
64 | 
Unloaded hub Senec (SK) | 
No | 

| 
65 | 
Loaded hub Ljubljana (SI) | 
No | 

| 
66 | 
Unloaded hub Ljubljana (SI) | 
No | 

| 
67 | 
Under investigation | 
No | 

| 
68 | 
Warehouse Bolzano | 
No | 

| 
69 | 
Loaded hub Bolzano (IT) | 
No | 

| 
70 | 
Unloaded hub Bolzano (IT) | 
No | 

| 
71 | 
Warehouse Castellbisbal | 
No | 

| 
72 | 
Loaded hub Castellbisbal (ES) | 
No | 

| 
73 | 
Unloaded hub Castellbisbal (ES) | 
No | 

| 
74 | 
Repackaged | 
No | 

| 
75 | 
Warehouse Burgas | 
No | 

| 
76 | 
Loaded hub Burgas (BG) | 
No | 

| 
77 | 
Unloaded hub Burgas (BG) | 
No | 

| 
78 | 
Loaded hub Buda (HU) | 
No | 

| 
79 | 
Unloaded hub Buda (HU) | 
No | 

| 
80 | 
Warehouse Vienna | 
No | 

| 
81 | 
Loaded hub Vienna (AT) | 
No | 

| 
82 | 
Unloaded hub Vienna (AT) | 
No | 

| 
86 | 
Warehouse Montana | 
No | 

| 
87 | 
Loaded hub Montana (BG) | 
No | 

| 
88 | 
Unloaded hub Montana (BG) | 
No | 

| 
89 | 
Warehouse Istanbul | 
No | 

| 
90 | 
Loaded hub Istanbul (TR) | 
No | 

| 
91 | 
Unloaded hub Istanbul (TR) | 
No | 

| 
92 | 
Loaded hub Budapest (HU) | 
No | 

| 
93 | 
Unloaded hub Budapest (HU) | 
No | 

**HTTP Errors**

| 
**Code** | 
**Description** | 

| 
200 | 
Returns result from the web service. | 

| 
400 | 
Bad request. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
422 | 
{"error": "AWB not found. Please check testMode param and awb number."} - the AWB number does not exist (or is not visible with the given testMode). | 

| 
500 | 
Internal Server Error / This action is unauthorized. |


---
### Shipment_Price_Web_Service_v1.1

`POST https://api1.inout.bg/api/v1/shipment-price`


We can now offer you the ability to ask for a shipment price directly from your company's software or website by taking advantage of "Shipment Price Web Service".

**Requirements**

| 
**API Endpoint** | 
**Description** | 

| 
shipment-price | 
You can receive a shipment price according to the provided shipment data. | 

**Method: POST**
**Authorization: Bearer API_TOKEN**

**API Call Input Fields**
**Body (JSON)**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
courierId | 
integer | 
yes | 
 | 
ID of courier. | 

| 
companyId | 
integer | 
yes | 
 | 
ID of company. | 

| 
weight | 
numeric | 
yes | 
 | 
Shipment weight in kg. | 

| 
codAmount | 
numeric | 
yes | 
 | 
Shipment COD amount in local currency. Set as 0 if the shipment does not have COD. | 

| 
openPackage | 
boolean | 
yes | 
 | 
Check up a shipment before pay ("open parcel" service). | 

| 
insuranceAmount | 
numeric | 
yes | 
 | 
Shipment insurance amount in BGN currency. Set as 0 if the shipment does not have insurance. | 

| 
returnDocs | 
enum | 
yes | 
Allowed values: 0, 1, 2 | 
Return documents service: 2 = nothing returns; 0 = document; 1 = waybill. | 

| 
saturdayDelivery | 
boolean | 
no | 
Default: 0 | 
Saturday delivery. | 

| 
toOffice | 
boolean | 
yes, unless courierId is 8 (Cargus) | 
 | 
If the shipment is to an office then this field is true, otherwise it is false. | 

| 
currency | 
string | 
no | 
3-letter code. Default: BGN | 
Currency in 3-letter code - for example: EUR, BGN, RON etc. For Bulgarian couriers the currency is always forced to BGN regardless of this field. | 

| 
serviceId | 
integer | 
no | 
Default: 1 | 
ID of the shipping service. | 

| 
fulfillqty | 
integer | 
no | 
Default: 0 | 
Number of fulfilment items, used to calculate the fulfilment price component. | 

| 
length | 
numeric | 
no | 
0 - 999 | 
Package length in cm. Used where dimensional pricing applies. | 

| 
width | 
numeric | 
no | 
0 - 999 | 
Package width in cm. Used where dimensional pricing applies. | 

| 
height | 
numeric | 
no | 
0 - 999 | 
Package height in cm. Used where dimensional pricing applies. | 

| 
city | 
string | 
no | 
Ignored | 
Accepted but IGNORED by the price calculation. Kept only for backward compatibility. | 

| 
county | 
string | 
no | 
Ignored | 
Accepted but IGNORED by the price calculation. Kept only for backward compatibility. | 

**Example:**

{
    "courierId": 15,
    "companyId": 333,
    "weight": 1,
    "codAmount": 100,
    "openPackage": 0,
    "insuranceAmount": 0,
    "returnDocs": 2,
    "saturdayDelivery": 0,
    "toOffice": 1,
    "currency": "BGN"
}

`

**Example URLs:**

Test: https://test-api.inout.bg/api/v1/shipment-price
Production: https://api1.inout.bg/api/v1/shipment-price

**API Response (Output Fields)**

All prices are returned in EUR, without VAT included.

| 
**Field** | 
**Description** | 

| 
price | 
Total shipment price in EUR (without VAT included). | 

| 
pr_weight | 
Price for the weight of the shipment. | 

| 
pr_cod | 
Price for the COD tax. | 

| 
pr_ins | 
Price for the insurance. | 

| 
pr_check | 
Price for the "open parcel" service. | 

| 
pr_ret | 
Price for the return document/AWB service. | 

| 
pr_fulfill | 
Price for the fulfilment service. | 

| 
pr_sat_del | 
Price for the Saturday delivery service. | 

| 
pr_sms | 
Price for SMS notification. | 

**Example:**

{
    "price": "3.99",
    "pr_weight": "3.99",
    "pr_cod": "0.00",
    "pr_ins": "0.00",
    "pr_check": "0.00",
    "pr_ret": "0.00",
    "pr_fulfill": "0.00",
    "pr_sat_del": "0.00",
    "pr_sms": "0.0000"
}

`

**Important:** if the price cannot be calculated due to an internal error, the service responds with HTTP 200 and ALL price fields equal to 0.00. Treat an all-zero response as "no price available" - do not use it as a real quote.

**HTTP Errors:**

| 
**Code** | 
**Description** | 

| 
200 | 
Returns result from the web service (including the all-zero "no price available" response described above). | 

| 
400 | 
Bad request. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
404 | 
{"error": "Invalid courier Id"} - the courierId does not exist or has no country configured. | 

| 
404 | 
{"error": "Invalid Input Data (ServiceId or Dimensions or not supported CountryId )"} - the price could not be calculated for the given serviceId / dimensions / destination country. | 

| 
500 | 
Internal Server Error / This action is unauthorized. |

Request body:
```json
{
	"courierId": 15,
	"companyId": 333,
	"weight": 1,
	"codAmount": 100,
	"openPackage": 0,
	"insuranceAmount": 0,
	"returnDocs": 2,
	"saturdayDelivery": 0,
	"toOffice": 1,
	"currency": "BGN"
}
```


---
### [DEPRECATED] Shipment_Price_Web_Service_v1.1 Romania

`POST https://api1.inout.bg/api/v1/shipment-price`


**This request is deprecated and kept only for backward compatibility.**

The `city`/`county` parameters shown here are accepted by the API but ignored by the price calculation - they never affected pricing (dead legacy code path). Use Shipment_Price_Web_Service_v1.1 instead - it covers Romania as well, plus the currently supported optional parameters (serviceId, fulfillqty, length/width/height, saturdayDelivery, currency).

Request body:
```json
{
	"courierId": 8,
	"companyId": 333,
	"weight": 1.000,
	"codAmount": 79.00,
	"openPackage": 0,
	"insuranceAmount": 0,
	"returnDocs": 2,
	"saturdayDelivery": 0,
	"city": "Abrud",
	"county": "Alba"
}
```


---
### AWB_Deletion_Web_Service-v1.0

`DELETE https://api1.inout.bg/api/v1/delete/40695693257`


We can now offer you the ability to delete an AWB directly from your company's software or website by taking advantage of "AWB Deletion Web Service".

Description:
With this service, you can delete a shipment that you no longer need. When the courier supports remote cancellation, the AWB is also cancelled at the courier's side. The AWB is always removed from our system — a possible error from the courier's side does not block the deletion in our system (the courier error is logged on our side).

**Requirements**

| 
**API Endpoint** | 
**Description** | 

| 
/delete/{waybillNum} | 
Deleting an AWB from our system and cancelling it at the courier when supported. | 

**Method: DELETE
Authorization: Bearer API_TOKEN
API Call Input Fields
URL path parameters**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
waybillNum | 
string | 
yes | 
 | 
The AWB number you received when creating the shipment. The AWB must belong to one of your companies. | 

**Example**:

Test - https://test-api.inout.bg/api/v1/delete/40695693257

Production - https://api1.inout.bg/api/v1/delete/40695693257

**API Response (Output Fields)**

| 
**Field** | 
**Description** | 

| 
success | 
true if the AWB was deleted successfully, false otherwise. | 

| 
awb | 
The AWB number from the request. | 

| 
error | 
A field that contains the text from a possible error while executing the web service from the server-side. Empty/null on success. | 

**Example:**

{
    "success": true,
    "awb": "40695693257",
    "error": null
}

`

HTTP Errors:

| 
**Code** | 
**Description** | 

| 
200 | 
The AWB was deleted successfully. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
404 | 
Not found AWB with the specified number! / Not found waybill! - the AWB does not exist or does not belong to your companies. | 

| 
500 | 
Internal server error! |


---
### Merged_Print_Web_Service-v1.0

`POST https://api1.inout.bg/api/v1/merged/print`


We can now offer you the ability to print several AWB labels as one merged PDF file directly from your company's software or website by taking advantage of "Merged Print Web Service".

Description:
With this service, you can send a list of AWB numbers and receive one merged PDF file (Base64 encoded) with the labels of all of them, in the same order as in your request. AWB numbers that cannot be printed (not found, not yours, or with an invalid label file) do not fail the whole request - they are returned in the "errorPrinting" field and the rest of the labels are merged normally.

**Requirements**

| 
**API Endpoint** | 
**Description** | 

| 
/merged/print | 
Printing the labels of several AWBs as one merged PDF file. | 

**Method: POST
Authorization: Bearer API_TOKEN
API Call Input Fields
Body (JSON)**

| 
**parameter** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
numbers | 
array of strings | 
yes | 
Min: 1, Max: 50 | 
List of AWB numbers to be printed. Maximum 50 AWBs can be printed at once. The AWBs must belong to your companies. | 

**Example**:

Test - https://test-api.inout.bg/api/v1/merged/print

Production - https://api1.inout.bg/api/v1/merged/print

{
    "numbers": [
        "40695693257",
        "40695693258",
        "40695693259"
    ]
}

`

**API Response (Output Fields)**

| 
**Field** | 
**Description** | 

| 
success | 
true if the merged PDF file was generated successfully, false otherwise. | 

| 
message | 
Text result of the operation or a possible error while executing the web service from the server-side. | 

| 
errorPrinting | 
Object with the AWB numbers that could not be printed. Each key is an AWB number and its value is the error text (e.g. "No found waybill"). Empty when all labels were printed. | 

| 
base64_pdf | 
The merged PDF file, Base64 encoded. | 

**Example:**

{
    "success": true,
    "message": "Success to print merged awb pdf file!",
    "errorPrinting": {
        "40695693259": "No found waybill"
    },
    "base64_pdf": "JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoK..."
}

`

HTTP Errors:

| 
**Code** | 
**Description** | 

| 
200 | 
The merged PDF file was generated. Check the "errorPrinting" field for AWBs that could not be printed. | 

| 
400 | 
The numbers parameter must be a non-empty array! | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
422 | 
Maximum 50 waybills can be printed at once! | 

| 
422 | 
No waybills found! | 

| 
500 | 
Internal Server Error / This action is unauthorized. |

Request body:
```json
{
    "numbers": [
        "40695693257",
        "40695693258",
        "40695693259"
    ]
}
```


## Location Web Services



---
### Cities_Suggestions_Web_Service_v1.0

`GET https://api1.inout.bg/api/v1/get-cities/suggestions/2/8290?testMode=0&searchAllFields=1`


We offer you the ability to ask for city suggestions directly from your company's software or website by taking advantage of the "Cities Suggestions Web Service".

**Requirements:**

| 
**API Endpoint** | 
**Description** | 
**Restrictions** | 

| 
/get-cities/suggestions/{countryId}/{string} | 
With this service, you can receive the cities in a chosen country by a string that is a part of, or the full, city name, region or postal code. | 
String parameter: min length 3 characters. 
CountryId parameter: must be a valid country ID (see the Countries Web Service). | 

**Method: GET**

**Authorization: Bearer API_TOKEN**

**API Call Input Fields**

**URL query parameters**

| 
**field** | 
**type** | 
**required** | 
**description** | 

| 
testMode | 
boolean | 
yes | 
If set to true, the lookup is performed against the test environment database instead of the production one. It only selects the data source for the search — nothing is created or changed. On the production environment use testMode=0. | 

| 
searchAllFields | 
boolean | 
no | 
By default, the system searches the city by zip code or city name. If you want to search by all fields (city name, postal code, county name, state, plus the Latin versions of these fields), set this field to true. | 

| 
toOffice | 
boolean | 
no | 
If set to true, the result is restricted to cities that have courier offices (useful when the shipment will be delivered to an office/locker). | 

| 
courierId | 
integer | 
no | 
Courier ID (see the Couriers Web Service). Used together with toOffice to filter the cities to those served by the chosen courier's office network. | 

**Examples:**

By zip code
https://api1.inout.bg/api/v1/get-cities/suggestions/2/700?testMode=0

By city name
https://api1.inout.bg/api/v1/get-cities/suggestions/2/рус?testMode=0
https://api1.inout.bg/api/v1/get-cities/suggestions/2/rus?testMode=0

Search by all fields (city name, postal code, county name, state + these fields in Latin characters)
https://api1.inout.bg/api/v1/get-cities/suggestions/2/рус?testMode=0&searchAllFields=1

Test environment
https://test-api.inout.bg/api/v1/get-cities/suggestions/2/рус?testMode=1

**Important**: The web service returns only the first 50 results it finds. If what you are looking for is not in the result, refine the search string.

**API Response (Output Fields)**

| 
**Field** | 
**Description** | 

| 
COUNTRY_ID | 
The ID of the country. | 

| 
COUNTY_ID | 
The ID of the county, if one exists for the location (see the Counties Romania Web Service). May be null. | 

| 
ID | 
The ID of the city. | 

| 
POSTAL_CODE | 
Zip code of the city. | 

| 
CITY_NAME_LOCAL | 
The city name in the local language. | 

| 
CITY_NAME_EN | 
The name of the city in Latin characters. | 

| 
COUNTY | 
Region of the location in the local language. | 

| 
COUNTY_EN | 
Region of the location in Latin characters. | 

| 
STATE | 
If the country uses states, this field is set to the local state name. | 

| 
STATE_EN | 
If the country uses states, this field is set to the state name in Latin characters. | 

| 
CRE_FROM_API | 
If true, the record was created through the API. | 

| 
RAPIDO_SITEID | 
The site (city) ID in the Rapido courier nomenclature. Populated for Bulgaria only; may be null. | 

| 
LOCALITYID | 
The locality ID in the courier nomenclature (used for couriers that require their own locality codes, e.g. Cargus in Romania). May be null. | 

Example:

{
    "suggestions": [
        {
            "COUNTRY_ID": 2,
            "COUNTY_ID": null,
            "ID": 32696,
            "POSTAL_CODE": "7000",
            "CITY_NAME_LOCAL": "Русе",
            "CITY_NAME_EN": "Ruse",
            "COUNTY": "Русе",
            "COUNTY_EN": "Ruse",
            "STATE": null,
            "STATE_EN": null,
            "CRE_FROM_API": null,
            "RAPIDO_SITEID": 512,
            "LOCALITYID": null
        },
        {
            "COUNTRY_ID": 2,
            "COUNTY_ID": null,
            "ID": 25731,
            "POSTAL_CODE": "7040",
            "CITY_NAME_LOCAL": "Русокастро",
            "CITY_NAME_EN": "Rusokastro",
            "COUNTY": "Бургас",
            "COUNTY_EN": "Burgas",
            "STATE": null,
            "STATE_EN": null,
            "CRE_FROM_API": null,
            "RAPIDO_SITEID": null,
            "LOCALITYID": null
        }
    ]
}

`

**HTTP Errors**

| 
**Code** | 
**Description** | 

| 
200 | 
Returns result from the web service. | 

| 
400 | 
Bad request. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
404 | 
Not found data. | 

| 
422 | 
Validation error. Returned when the countryId is not a valid country ID, or when the search string is shorter than 3 characters ({"error":"The field string must be with length greater than 3!"}). | 

| 
500 | 
Internal Server Error / This action is unauthorized. | 

Note: Requests may be rate-limited at infrastructure level. Please use reasonable request rates and contact euShipments if you plan bulk usage.


---
### Cities_Web_Service_v1.0

`GET https://api1.inout.bg/api/v1/get-cities/1?first=1&skip=0&paging=0`


We offer you the ability to ask for cities directly from your company's software or website by taking advantage of the "Cities Web Service".

**Requirements**

| 
**API Endpoint** | 
**Description** | 
**Restrictions** | 

| 
/get-cities/{countryId} | 
With this service, you can receive the cities in a chosen country. | 
Not available for Great Britain (countryId 23) — use the Cities Suggestions Web Service instead. | 

**Method: GET**

**Authorization: Bearer API_TOKEN**

**API Call Input Fields**

**URL query parameters**

| 
**field** | 
**type** | 
**required** | 
**description** | 

| 
paging | 
boolean | 
yes | 
Set to true if you want to get only a portion of the records (paginated), or false to get all records. | 

| 
first | 
integer | 
in some cases | 
Required if the paging parameter equals true. The number of records you want returned. | 

| 
skip | 
integer | 
in some cases | 
Required if the paging parameter equals true. The number of records you want skipped. | 

| 
county_id | 
integer | 
no | 
County ID, obtained from the Counties Romania Web Service. You can use this field only for Romania. | 

| 
office_id | 
integer | 
no | 
Office ID (Romanian agency ID). You can use this field only for Romania. Contact euShipments if you need this filter. | 

**Examples:**

Test environment
https://test-api.inout.bg/api/v1/get-cities/1?first=1&skip=0&paging=0

Production environment
https://api1.inout.bg/api/v1/get-cities/1?first=1&skip=0&paging=0

**API Response (Output Fields)**

| 
**Field** | 
**Description** | 

| 
ID | 
ID of the city. | 

| 
POSTAL_CODE | 
Zip code of the city. | 

| 
CITY_NAME_LOCAL | 
The city name in the local language. | 

| 
CITY_NAME_EN | 
The name of the city in Latin characters. | 

| 
COUNTY | 
Region of the location in the local language. | 

| 
COUNTY_ID | 
The ID of the county, if one exists for the location (see the Counties Romania Web Service). Null where not applicable. | 

| 
COUNTY_EN | 
Region of the location in Latin characters. | 

| 
MUNICIPALITY | 
The municipality name — meaningful for Bulgaria only. For other countries this field is repurposed internally and should be ignored. | 

| 
STATE | 
If the country uses states, this field is set to the local state name. | 

| 
STATE_EN | 
If the country uses states, this field is set to the state name in Latin characters. | 

| 
MANUAL_EDIT | 
If this field is equal to 1, the city was added manually through the cabinet into the nomenclature. | 

| 
RAPIDO_SITEID | 
The site (city) ID in the Rapido courier nomenclature. Returned for Bulgaria (countryId 2) only; may be null. | 

**Example**:

[
    {
        "ID": 24370,
        "POSTAL_CODE": "1528",
        "CITY_NAME_LOCAL": "Абдовица",
        "CITY_NAME_EN": null,
        "COUNTY": "София",
        "COUNTY_ID": null,
        "COUNTY_EN": null,
        "MUNICIPALITY": "Столична",
        "STATE": null,
        "STATE_EN": null,
        "MANUAL_EDIT": null,
        "RAPIDO_SITEID": null
    },
    {
        "ID": 24372,
        "POSTAL_CODE": "2932",
        "CITY_NAME_LOCAL": "Абланица",
        "CITY_NAME_EN": "Ablanitsa",
        "COUNTY": "Благоевград",
        "COUNTY_ID": null,
        "COUNTY_EN": "Blagoevgrad",
        "MUNICIPALITY": "Хаджидимово",
        "STATE": null,
        "STATE_EN": null,
        "MANUAL_EDIT": null,
        "RAPIDO_SITEID": null
    }
]

`

**HTTP Errors**

| 
Code | 
Description | 

| 
200 | 
Returns result from the web service. | 

| 
400 | 
Bad request. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
404 | 
Not found data. | 

| 
422 | 
Unprocessable Entity. Wrong input data. Also returned when: 
- countryId is 23 (Great Britain): {"error":"Unsupported operation! Please, for Great Britain use the web service "Cities Suggestions Web Service"!"} 
- the filters match no records: {"error":"Wrong params (country id, office id or country id)!"} | 

| 
500 | 
Internal Server Error / This action is unauthorized. |


---
### Counties_Romania_Web_Service_v1.0

`GET https://api1.inout.bg/api/v1/get-counties/1`


We offer you the ability to ask for the counties of Romania directly from your company's software or website by taking advantage of the "Counties Romania Web Service".

**Requirements:**

| 
**API Endpoint** | 
**Description** | 
**Restrictions** | 

| 
/get-counties/{countryId} | 
With this service, you can receive the counties in Romania. | 
countryId must be 1 (Romania). Any other value returns HTTP 422 with {"error":"Unavailable service for the chosen country!"}. | 

**Method: GET**

**Authorization: Bearer API_TOKEN**

**Examples:**

Test environment
https://test-api.inout.bg/api/v1/get-counties/1

Production environment
https://api1.inout.bg/api/v1/get-counties/1

**API Response (Output Fields)**

| 
**Field** | 
**Description** | 

| 
id | 
ID of the county. | 

| 
abr | 
County abbreviation. | 

| 
name | 
County name. | 

**Example:**

[
  {
    "id": 3,
    "abr": "AB",
    "name": "Alba"
  },
  {
    "id": 4,
    "abr": "AR",
    "name": "Arad"
  }
]

`

**HTTP Errors**

| 
**Code** | 
**Description** | 

| 
200 | 
Returns result from the web service. | 

| 
400 | 
Bad request. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
404 | 
Not found data. | 

| 
422 | 
Unprocessable Entity. Wrong input data, or a country other than Romania was requested: {"error":"Unavailable service for the chosen country!"}. | 

| 
500 | 
Internal Server Error / This action is unauthorized. |


---
### Countries_Web_Service_v1.0

`GET https://api1.inout.bg/api/v1/get-countries`


We offer you the ability to ask for countries directly from your company's software or website by taking advantage of the "Countries Web Service".

**Requirements:**

| 
**API Endpoint** | 
**Description** | 

| 
/get-countries | 
With this service, you can receive the countries for which you can create shipments. | 

**Method: GET**

**Authorization: Bearer API_TOKEN**

**Important**: The returned list is specific to your account — it contains the countries covered by the couriers activated for your client account. If the list is empty, the service returns HTTP 404 with {"error":"You do not have access to countries!"} — in that case, please contact euShipments to activate couriers for your account.

**Examples:**

Test environment
https://test-api.inout.bg/api/v1/get-countries

Production environment
https://api1.inout.bg/api/v1/get-countries

**API Response (Output Fields)**

| 
**Field** | 
**Description** | 

| 
ID | 
ID of the country. | 

| 
NAME | 
Country name. | 

| 
CYRILLIC_NAME | 
The name of the country in Cyrillic. | 

| 
ISO_CODE | 
Two-letter country code (ISO 3166-1 alpha-2). Use this value as countryIsoCode when creating shipments. | 

**Example:**

[
    {
        "ID": 1,
        "NAME": "Romania",
        "CYRILLIC_NAME": "Румъния",
        "ISO_CODE": "RO"
    },
    {
        "ID": 2,
        "NAME": "Bulgaria",
        "CYRILLIC_NAME": "България",
        "ISO_CODE": "BG"
    },
    {
        "ID": 3,
        "NAME": "Hungary",
        "CYRILLIC_NAME": "Унгария",
        "ISO_CODE": "HU"
    }
]

`

**HTTP Errors**

| 
**Code** | 
**Description** | 

| 
200 | 
Returns result from the web service. | 

| 
400 | 
Bad request. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
404 | 
Not found data. Returned with {"error":"You do not have access to countries!"} when no couriers are activated for your account — contact euShipments. | 

| 
422 | 
Unprocessable Entity. Wrong input data. | 

| 
500 | 
Internal Server Error / This action is unauthorized. |


---
### Courier_Offices_Web_Service_v1.2

`GET https://api1.inout.bg/api/v1/offices-by-courier/{courierId}`


We offer you the ability to ask for courier offices directly from your company's software or website by taking advantage of the "Courier Offices Web Service".

**Requirements:**

| 
**API Endpoint** | 
**Description** | 

| 
/offices-by-courier/{courierId} | 
With this service, you can receive the offices (including automated parcel lockers/stations) for a chosen courier. Obtain the courierId from the Couriers Web Service. | 

**Method: GET**

**Authorization: Bearer API_TOKEN**

**API Call Input Fields**

**URL query parameters**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
per_page | 
integer | 
no | 
min 50, max 1000 | 
Number of offices per page. Enables paginated mode — must be combined with the page parameter. | 

| 
page | 
integer | 
no | 
min 1 | 
Page number. Enables paginated mode — must be combined with the per_page parameter. | 

| 
id | 
integer | 
no | 
min 1 | 
Return a single office by its ID (the ID field from this same nomenclature). | 

Without query parameters the service returns ALL offices of the courier in one response. For couriers with large office networks we recommend the paginated mode.

**Examples:**

All offices (test environment)
https://test-api.inout.bg/api/v1/offices-by-courier/15

All offices (production environment)
https://api1.inout.bg/api/v1/offices-by-courier/15

Paginated
https://api1.inout.bg/api/v1/offices-by-courier/15?per_page=100&page=1

Single office by ID
https://api1.inout.bg/api/v1/offices-by-courier/15?id=1297

**API Response (Output Fields)**

| 
**Field** | 
**Description** | 

| 
ID | 
ID of the office. Use this value as recipient.officeId when creating a shipment to an office. | 

| 
CITY_ID | 
The ID of the city where the office is located. | 

| 
COURIER_ID | 
The ID of the courier. | 

| 
COURIER_OFFICE_ID | 
The office ID in the subcontractor's (courier's) own nomenclature. | 

| 
OFFICE_NAME | 
Name of the office. | 

| 
COURIER_OFFICE_CODE | 
The office code in the subcontractor's (courier's) own nomenclature. | 

| 
CITY_NAME | 
Name of the city where the office is located. | 

| 
ADDRESS | 
Office address. | 

| 
LATITUDE | 
Office latitude. | 

| 
LONGITUDE | 
Office longitude. | 

| 
WORK_BEGIN | 
Opening time of the office during the week. | 

| 
WORK_END | 
Closing time of the office during the week. | 

| 
WORK_BEGIN_SATURDAY | 
Opening time of the office on Saturday. | 

| 
WORK_END_SATURDAY | 
Closing time of the office on Saturday. | 

| 
GROUP_CITY_ID | 
ID of the city in the euShipments cities nomenclature (matches the ID field returned by the Cities web services). | 

| 
POST_CODE | 
Zip code of the city. For Romania, postal codes are missing for some large cities. | 

| 
REGION | 
Region. For some countries it is null — the nomenclature does not support data for the region. | 

| 
IS_STATION | 
If true, the point is an automated parcel locker/station rather than a staffed office. | 

| 
COD_SUPPORT | 
If true, cash on delivery is accepted at this point. | 

**Example (non-paginated / single office):**

[
  {
        "ID": 1297,
        "CITY_ID": 24392,
        "COURIER_ID": 15,
        "COURIER_OFFICE_ID": 1053,
        "OFFICE_NAME": "Айдемир",
        "COURIER_OFFICE_CODE": "7538",
        "CITY_NAME": "Айдемир",
        "ADDRESS": "Айдемир кв. Деленките ул. София №7",
        "LATITUDE": "44.1009192550187000",
        "LONGITUDE": "27.1950400265455000",
        "WORK_BEGIN": "09:00:00",
        "WORK_END": "18:00:00",
        "WORK_BEGIN_SATURDAY": "09:00:00",
        "WORK_END_SATURDAY": "15:00:00",
        "GROUP_CITY_ID": 24392,
        "POST_CODE": "7538",
        "REGION": "Силистра",
        "IS_STATION": false,
        "COD_SUPPORT": true
    },
    {
        "ID": 1298,
        "CITY_ID": 24396,
        "COURIER_ID": 15,
        "COURIER_OFFICE_ID": 133,
        "OFFICE_NAME": "Айтос Автогара",
        "COURIER_OFFICE_CODE": "8501",
        "CITY_NAME": "Айтос",
        "ADDRESS": "Айтос ул. Хаджи Димитър №31",
        "LATITUDE": "42.7066729507548500",
        "LONGITUDE": "27.2505099280334600",
        "WORK_BEGIN": "09:00:00",
        "WORK_END": "18:00:00",
        "WORK_BEGIN_SATURDAY": "09:00:00",
        "WORK_END_SATURDAY": "15:00:00",
        "GROUP_CITY_ID": 24396,
        "POST_CODE": "8500",
        "REGION": "Бургас",
        "IS_STATION": false,
        "COD_SUPPORT": true
    }
]

`

**Example (paginated, per_page + page):**

{
    "offices": [
        {
            "ID": 1297,
            "CITY_ID": 24392,
            "COURIER_ID": 15,
            "...": "... same office fields as above ..."
        }
    ],
    "pagination": {
        "current_page": 1,
        "per_page": 100,
        "total": 3456,
        "last_page": 35,
        "from": 1,
        "to": 100,
        "has_more_pages": true
    }
}

`

**HTTP Errors**

| 
**Code** | 
**Description** | 

| 
200 | 
Returns result from the web service. | 

| 
400 | 
Bad request. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
404 | 
No offices found for the courier, or the office requested with the id parameter does not exist ({"error":"Office not found"}). | 

| 
422 | 
Validation error for the per_page, page or id parameters (paginated mode). | 

| 
500 | 
Internal Server Error / This action is unauthorized. | 

| 
503 | 
Invalid courierId (non-paginated mode). |


## Fulfilment documentation

We can now offer you the ability to ask order creation from your company’s software or website by taking advantage of "Order Creation Web Service".

---
### Order_Creation_Web_Service-v1.2

`POST https://api1.inout.bg/api/v1/fulfilment/create-order`


We can now offer you the ability to ask order creation from your company's software or website by taking advantage of "Order Creation Web Service".

**Requirements**

| 
**API Endpoint** | 
**Description** | 

| 
/fulfilment/create-order | 
Creating a order in our fulfilment system. | 

Method: POST
Authorization: Bearer API_TOKEN
Body (JSON)

**Example URLs:**

| 
**Environment** | 
**URL** | 

| 
Test | 
https://test-api.inout.bg/api/v1/fulfilment/create-order | 

| 
Production | 
https://api1.inout.bg/api/v1/fulfilment/create-order | 

**Important!!!**
You can upload orders only if the products from the orders are available (there is enough stock) in euShipments warehouse.

**API Call Input Fields**

| 
**parameter** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
testMode | 
bool | 
yes | 
 | 
if you want to use the API only for tests set this field to true. Applies only to the production environment. On the test environment, all shipments save on test env. | 

| 
senderId | 
integer | 
yes | 
There must be a company with the selected ID. | 
ID of company, you can receive it from the „Companies Web Service". | 

| 
courierId | 
integer | 
no | 
There must be a courier with the selected ID. | 
ID of courier, you can receive it from the „Couriers Web Service". If the field is omitted, the courier is assigned automatically by euShipments. | 

| 
waybillAvailableDate | 
date | 
yes | 
From today up to 9 days ahead. Cannot be in the past and cannot be more than 9 days in the future. | 
Date when the order should be processed. | 

| 
serviceName | 
string | 
no | 
Must be an existing service name and must be offered by the selected courier. | 
The service name must be one of the following:  
• crossborder  
• eushipmentsairexpress  
• eushipmentsglobal economy  
• eushipmentsglobal premium  
If the parameter is not present, the service is resolved automatically: the first service configured for the selected courier, otherwise the system default (crossborder). | 

| 
warehouseInfo | 
boolean | 
no | 
 | 
If set to true, the response also contains a warehouse object (see API Response below) with the name and country of the warehouse that will fulfil the order. | 

| 
**recipient** | 
object | 
yes | 
 | 
 | 

| 
name | 
string | 
yes | 
MaxLength: 100 | 
Name of recipient or company. Typically, both customer names (first name and last name) or company name are filled in. | 

| 
cityId | 
integer | 
no | 
The parameter is mandatory if city and country data are not filled in. There must be a city with the selected ID. | 
The ID of a city where the shipment needs to delivery. Obtain an ID from Cities resource. Please for more information, see Cities web service. | 

| 
countryIsoCode | 
string | 
no | 
Mandatory whenever recipient.cityId is not sent. Uppercase ISO 3166-1 alpha-2 code (e.g. BG, RO, HU). Must be an existing country. | 
Country ISO code. | 

| 
cityName | 
string | 
no | 
Required field if city ID is not present. MaxLength: 100 | 
Recipient's city name e.g. Sofia. | 

| 
zipCode | 
string | 
no | 
Required field if neither city ID nor region is present. MaxLength: 15 | 
Recipient's city zip code e.g. 1000. | 

| 
region | 
string | 
no | 
Required for Romania. Required field if neither city ID nor zip code is present. MaxLength: 100 | 
Recipient's region e.g. София. | 

| 
officeId | 
integer | 
no | 
There must be an office with the selected ID. | 
Obtain an ID from City offices or Courier offices resource. Please see one of the two web services for more information. When sent, the shipment is created to the office and streetName is not required. | 

| 
officeCode | 
string | 
no | 
There must be an office with the selected code. | 
Obtain a COURIER OFFICE CODE from City offices or Courier offices resource. Please see one of the two web services for more information. When sent, the shipment is created to the office and streetName is not required. | 

| 
streetName | 
string | 
yes* | 
Required unless recipient.officeId or recipient.officeCode is sent. MaxLength: 200 | 
name of the street, office address or office name - e.g. If you create a shipment to address - Main street or Main street 10. If you want to create a shipment to an office and not use the "officeId" or "officeCode", please add a keyword "to office: " to office name or office address (obtain information from "offices address" web service.) e.g. " to office: Русе Николаевска" or " to office: Русе ж.к. ЦЮР ул. Николаевска №109". | 

| 
buildingNumber | 
string or number | 
no | 
MaxLength: 100 | 
Number of the street/building - e.g. 10. If the value is longer than 8 characters, only the first 8 characters are kept as building number and the rest is automatically appended to addressText after a "|" separator. | 

| 
addressText | 
string | 
no | 
MaxLength: 300 (values longer than 100 characters are truncated to 100 when the order is stored) | 
Additional address information – e.g. бл.25 вх.1 ет.3 ап.4 or bl.25 vh.1 et.3 ap.4 or another information for the address. | 

| 
contactPerson | 
string | 
no | 
MaxLength: 100 | 
Contact person. Usually is the same as the name of recipient. | 

| 
phoneNumber | 
string | 
yes | 
MaxLength: 100 | 
Recipient's phone number. Required (a few country-specific exceptions exist where a default number is applied). | 

| 
email | 
string | 
no | 
Not validated. | 
Recipient's email. | 

| 
**awb** | 
object | 
yes | 
 | 
 | 

| 
parcels | 
integer | 
yes | 
Min: 0 | 
Number of parcels in the shipment. | 

| 
envelopes | 
integer | 
yes | 
Min: 0 | 
Number of envelopes in the shipment. The field is required but may be 0. | 

| 
totalWeight | 
numeric | 
yes | 
Min: 0.01 | 
Total weight of the shipment in kg. | 

| 
declaredValue | 
numeric | 
no | 
Min: 0 | 
Insurance amount of the shipment. | 

| 
bankRepayment | 
numeric | 
no | 
Min: 0 | 
COD amount of the shipment. You can set to 0 if the shipment doesn't have a COD amount. | 

| 
otherRepayment | 
string | 
no | 
MaxLength: 100 | 
Additional information to COD. | 

| 
observations | 
string | 
no | 
MaxLength: 300 | 
Additional information about the shipment/products. (**notes**) | 

| 
openPackage | 
boolean | 
no | 
 | 
Check up the shipment before pay. Not available for all countries. | 

| 
shipmentPayer | 
string | 
no | 
ENUM: sender, recipient | 
Who pays the shipment. Any other value is rejected with HTTP 400 and the message "The recipient.shipmentPayer text must be sender or recipient.". | 

| 
saturdayDelivery | 
boolean | 
no | 
 | 
Saturday delivery. Not available for some countries. | 

| 
**referenceNumber** | 
string | 
yes | 
MaxLength: 100 | 
Client reference number. Usually, the client put here the unique number of order from the site or unique order number of the content or invoice number. Helps for tracking and reporting.  
**Important: The information in the field must be unique to avoid duplicate shipments!** | 

| 
referenceNumberDate | 
date | 
no | 
 | 
Date of the client order (reference number). | 

| 
products | 
string | 
no | 
MaxLength: 1000 | 
The content of the shipment. e.g. product1 product2. | 

| 
fragile | 
boolean | 
no | 
 | 
Marker whether the content is fragile. (fragile = 1 if the content is fragile) | 

| 
productsInfo | 
string | 
no | 
MaxLength: 2000 | 
Аdditional product information. | 

| 
piecesInPack | 
integer | 
no | 
 | 
Products amount in one shipment. e.g If the shipment contain 5 products the field will be filled with 5. | 

| 
packages | 
array of objects | 
no | 
 | 
Physical packages of the shipment. Each element contains dimensions and weight (see below). | 

| 
packages.*.dimensions.width | 
numeric | 
no | 
Min: 0.1 | 
Package width in cm. | 

| 
packages.*.dimensions.height | 
numeric | 
no | 
Min: 0.1 | 
Package height in cm. | 

| 
packages.*.dimensions.length | 
numeric | 
no | 
Min: 0.1 | 
Package length in cm. | 

| 
packages.*.weight | 
numeric | 
no | 
Min: 0.001 | 
Package weight in kg. | 

| 
document | 
object | 
no | 
 | 
A document attached to the shipment. | 

| 
document.type | 
string | 
no | 
ENUM: invoice | 
Type of the document. | 

| 
document.content | 
string | 
no | 
 | 
The document content as a base64 encoded string. | 

| 
document.format | 
string | 
no | 
ENUM: pdf | 
Format of the document. | 

| 
**products** | 
Array of objects | 
no | 
 | 
The content of the shipment, described as individual products. Not enforced by the API as required, but you should send either products or boxes so the order has a documented content. | 

| 
refNumber | 
string | 
yes | 
 | 
Product reference number. That is your product code or barcode. | 

| 
qty | 
integer | 
yes | 
Min: 1 | 
Product quantity. | 

| 
price | 
numeric | 
no | 
 | 
Unit price of the product (with VAT).  
**Important:** for senders with a cash-receipt configuration for Econt or Speedy, the sum of price × qty over all product lines must equal awb.bankRepayment, otherwise the order is rejected. | 

| 
priceWithoutVat | 
numeric | 
no | 
 | 
Unit price of the product without VAT. | 

| 
**boxes** | 
Array of objects | 
no | 
 | 
Alternative to the flat products array – products grouped in boxes. | 

| 
refNumberBox | 
string | 
yes | 
 | 
Reference number of the box. Required for every box element. | 

| 
items | 
Array of objects | 
yes | 
Min: 1 element | 
Products in the box. Each item contains refNumber (string, required), qty (integer, required, min 1), price (numeric, optional) and priceWithoutVat (numeric, optional) with the same meaning as in the products array. | 

| 
**courierRequest** | 
object | 
no | 
 | 
Courier pickup request. | 

| 
courierRequest.date | 
date | 
no | 
Today or later. | 
Date of the courier pickup request. | 

| 
courierRequest.timeFrom | 
time | 
no | 
Format: H:i | 
Earliest pickup time. | 

| 
courierRequest.timeTo | 
time | 
no | 
Format: H:i | 
Latest pickup time. | 

| 
**returnLabel** | 
object | 
no | 
 | 
 | 

| 
returnLabel.nDaysValid | 
numeric | 
no | 
Min: 0 | 
Number of days the return label is valid. | 

| 
courierReturnAWB | 
boolean | 
no | 
 | 
If set to true, a courier return AWB is created for the shipment. | 

| 
**sender** | 
object | 
no | 
 | 
Sender contact data override. | 

| 
sender.name | 
string | 
no | 
MaxLength: 255 | 
Sender name. | 

| 
sender.phoneNumber | 
string | 
no | 
MaxLength: 20 | 
Sender phone number. | 

| 
sender.email | 
email | 
no | 
 | 
Sender email. | 

| 
sender.econtCODAggrement | 
string | 
no | 
MaxLength: 20 | 
Econt COD agreement number. | 

| 
**invoice** | 
object | 
no | 
 | 
 | 

| 
invoice.number | 
string | 
no | 
MaxLength: 30 | 
Invoice number. | 

| 
invoice.issueDate | 
date | 
no | 
 | 
Invoice issue date. | 

| 
**customsData** | 
object | 
no | 
 | 
 | 

| 
dutyPaymentInfo | 
string | 
no | 
Mandatory field for countries outside the European Union.  
ENUM: DDU (Delivery duty unpaid), DDP (Delivery duty paid) | 
dutyPaymentInfo | 

| 
customsValue | 
numeric 15.2 | 
no | 
Mandatory field for countries outside the European Union. | 
customsValue | 

| 
**customs_declaration** | 
object | 
no | 
 | 
Customs declaration data for non-EU destinations. When the block is present, its products and exportData parts are required. | 

| 
customs_declaration.products | 
Array of objects | 
yes* | 
Min: 1 element. Required when customs_declaration is present. | 
Declared products. | 

| 
customs_declaration.products.*.description | 
string | 
yes | 
MaxLength: 255 | 
Product description. | 

| 
customs_declaration.products.*.taric | 
string | 
yes | 
MaxLength: 10 | 
TARIC code. | 

| 
customs_declaration.products.*.base_value | 
numeric | 
yes | 
Min: 0.01 | 
Declared value of the product. | 

| 
customs_declaration.products.*.quantity | 
integer | 
yes | 
Min: 1 | 
Declared quantity. | 

| 
customs_declaration.products.*.weight | 
integer | 
yes | 
Min: 1 | 
Declared weight. | 

| 
customs_declaration.products.*.country_of_origin | 
string | 
yes | 
Uppercase ISO 3166-1 alpha-2 code. | 
Country of origin. | 

| 
customs_declaration.products.*.client_ref | 
string | 
yes | 
MaxLength: 100 | 
Client reference of the product. | 

| 
customs_declaration.exportData | 
object | 
yes* | 
Required when customs_declaration is present. | 
Export data. | 

| 
customs_declaration.exportData.country_of_export | 
string | 
yes | 
Uppercase ISO 3166-1 alpha-2 code. | 
Country of export. | 

| 
customs_declaration.exportData.declaration_country | 
string | 
yes | 
Uppercase ISO 3166-1 alpha-2 code. | 
Country where the declaration is submitted. | 

| 
customs_declaration.exportData.ioss_number | 
string | 
yes* | 
MaxLength: 15. Required when customs_declaration is present (optional for some couriers). | 
IOSS number. | 

**API Response (Output Fields)**

| 
**Field** | 
**Description** | 

| 
orderId | 
ID of order. | 

| 
code | 
HTTP status code. | 

| 
error | 
A field that contains the text from a possible error while executing the web service from the server-side. | 

| 
warehouse | 
Returned only when warehouseInfo = true is sent. Object with name and country of the warehouse that will fulfil the order (null on error). | 

**Example:**

{
    "orderId": 745770,
    "error": false,
    "code": 200
}

`

**HTTP Errors:**

| 
**Code** | 
**Description** | 

| 
200 | 
The order created successfully. | 

| 
400 | 
Bad request. Returned also for an invalid awb.shipmentPayer value: "The recipient.shipmentPayer text must be sender or recipient." | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
404 | 
Not found record. | 

| 
422 | 
Wrong params. | 

| 
500 | 
Internal Server Error / This action is unauthorized. |

Request body:
```json
{
    "testMode": 0,
    "senderId": 333,
    "courierId": 15,
    "waybillAvailableDate": "2020-01-27",
    "serviceName": "crossborder",
    "recipient": {
        "name": "Test User",
        "cityId": null,
        "countryIsoCode": "BG",
        "cityName": "София",
        "zipCode": "1000",
        "region": null,
        "officeId": null,
        "officeCode": null,
        "streetName": "test street",
        "buildingNumber": "0",
        "addressText": "additional text, address test",
        "contactPerson": "Test User",
        "phoneNumber": "+36000000000",
        "email": ""
    },
    "awb": {
        "parcels": 1,
        "envelopes": 0,
        "totalWeight": 1.000,
        "declaredValue": 0,
        "bankRepayment": "25.5",
        "otherRepayment": "additional text for repayment",
        "observations": null,
        "openPackage": false,
        "shipmentPayer": "sender",
        "saturdayDelivery": false,
        "referenceNumber": "000002",
        "products": "test product test product1",
        "fragile": 1,
        "piecesInPack": 5,
        "productsInfo": "1111,2222,3333,4444,5555"
    },
    "products": [
        {
            "refNumber": "33445",
            "qty": 3
        },
        {
            "refNumber": "3344",
            "qty": 4
        }
    ],
    "customsData": {
        "dutyPaymentInfo": "DDU",
        "customsValue": "35.50"
    }
}
```


---
### Attach_PDF_Files_Web_Service-v1.0

`POST https://api1.inout.bg/api/v1/fulfilment/attach-pdf-files`


We can now offer you the ability to attach PDF file (invoice) from your company's software or website by taking advantage of "Attach PDF Files Web Service".

**Requirements**

| 
**API Endpoint** | 
**Description** | 

| 
/fulfilment/attach-pdf-files | 
You can attach files to your order. | 

Method: POST
Authorization: Bearer API_TOKEN
Body (JSON)

**Example URLs:**

| 
**Environment** | 
**URL** | 

| 
Test | 
https://test-api.inout.bg/api/v1/fulfilment/attach-pdf-files | 

| 
Production | 
https://api1.inout.bg/api/v1/fulfilment/attach-pdf-files | 

**Important!!!**
Files can be attached only **before the AWB is generated** for the order. Once the order already has an AWB, the order is no longer found by this service and the request returns HTTP 422 (see below). Pre-AWB orders are also rejected with the error "For specified order, you can not add documents!".

**API Call Input Fields**

| 
**parameter** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
testMode | 
bool | 
yes | 
 | 
if you want to use the API only for tests set this field to true. Applies only to the production environment. On the test environment, all shipments save on test env. | 

| 
orderId | 
integer | 
no | 
Required if the reference number not present. | 
ID of order. | 

| 
referenceNumber | 
string | 
no | 
MaxLength: 100 | 
Reference number (usually the reference number is the order number from your system.) | 

| 
**files** | 
array | 
yes | 
**Max: 1 element per request.** | 
Array with the files to attach. To attach more than one file, send a separate request for each file. | 

| 
base64Attached | 
string | 
yes | 
The decoded content must be a real PDF file (the file signature is validated). If the content is not a PDF, the request fails with "The file must be in pdf format!". | 
The base64 formatted string. | 

**Example (request body):**

{
  "testMode": false,
  "orderId": null,
  "referenceNumber": "0000026",
  "files": [
    {
      "base64Attached": "base64 string"
    }
  ]
}

`

**API Response (Output Fields)**

The response is always a **JSON array** with one object per processed file:

| 
**Field** | 
**Description** | 

| 
error | 
false on success, or the text of the error while executing the web service from the server-side. | 

| 
orderId | 
ID of order. | 

| 
referenceNumber | 
Client reference number. (order number, invoice number or other unique number) | 

| 
pdfId | 
The ID for your attached pdf (null on error). | 

| 
pdfCode | 
The code for your attached pdf (null on error). | 

| 
code | 
HTTP status code for this file. | 

**Example (success):**

[
  {
    "error": false,
    "orderId": 745770,
    "referenceNumber": "0000026",
    "pdfId": 1024,
    "pdfCode": "5420122-333-1",
    "code": 200
  }
]

`

**Example (order not found — returned with HTTP status 422):**

[
  {
    "error": "Not found order with the specified number!",
    "orderId": 123,
    "referenceNumber": "0000026",
    "pdfId": null,
    "pdfCode": null,
    "code": 422
  }
]

`

**HTTP Errors:**

| 
**Code** | 
**Description** | 

| 
200 | 
The pdf files added successfully. | 

| 
400 | 
Bad request. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
422 | 
Wrong params / Not found order with the specified number (the order does not exist, is not yours, or already has a generated AWB). | 

| 
500 | 
Internal Server Error / This action is unauthorized. Returned also when the file content is not a valid PDF ("The file must be in pdf format!") and when documents cannot be added to the specified order ("For specified order, you can not add documents!"). |

Request body:
```json
{
  "testMode": false,
  "orderId": null,
  "referenceNumber": "0000026",
  "files": [
    {
      "base64Attached": "base64 string"
    }
  ]
}
```


---
### Orders_History_Web_Service-v1.0

`POST https://api1.inout.bg/api/v1/fulfilment/orders-history`


We can now offer you the ability to receive statuses history by order data from your company's software or website by taking advantage of "Orders History Web Service".

**Requirements**

| 
**API Endpoint** | 
**Description** | 

| 
/fulfilment/orders-history | 
Receiving the orders information. | 

Method: POST
Authorization: Bearer API_TOKEN
Body (JSON)

**Example URLs:**

| 
**Environment** | 
**URL** | 

| 
Test | 
https://test-api.inout.bg/api/v1/fulfilment/orders-history | 

| 
Production | 
https://api1.inout.bg/api/v1/fulfilment/orders-history | 

**API Call Input Fields**

| 
**parameter** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
testMode | 
bool | 
yes | 
 | 
if you want to use the API only for tests set this field to true. Applies only to the production environment. On the test environment, all shipments save on test env. | 

| 
**orders** | 
array | 
yes | 
1 to 100 elements. | 
Array with the orders you want to check. | 

| 
refNum | 
string | 
no (nullable) | 
 | 
Reference number of the order. If the value is missing or no order with this reference number exists, the response contains a "not found" entry for it (see the example below). | 

**Example:**

{
    "testMode": 0,
    "orders": [
        {
            "refNum": "5420122"
        }, 
        {
            "refNum": "21555"
        },
        {
            "refNum": "TEST488"
        },
        {
            "refNum": "55555555555555555555"
        }
    ]
}

`

**API Response (Output Fields)**

The response is a JSON array with one object per requested order:

| 
**Field** | 
**Description** | 

| 
refNum | 
Order reference number. | 

| 
awb | 
AWB number. | 

| 
newReturnNumber | 
Return AWB number, when a return shipment has been created for the order (null otherwise). | 

| 
error | 
A field that contains the text from a possible error while executing the web service from the server-side. | 

| 
errorCode | 
Error code if it is from our server. | 

| 
statusesHistory | 
Array with statuses history. | 

| 
items | 
Array with the order items. Each item contains refNumber (product reference number), sn (serial number) and qty (quantity). | 

**Shipment statuses** (current as of July 2026, generated from the live system):

| 
**ID** | 
**Status** | 
**Final Status** | 

| 
1 | 
On delivery | 
No | 

| 
2 | 
In transit | 
No | 

| 
3 | 
Delivered | 
Yes | 

| 
4 | 
Returned | 
Yes | 

| 
5 | 
In the office | 
No | 

| 
6 | 
COD paid | 
Yes | 

| 
7 | 
New | 
No | 

| 
8 | 
Cancelled | 
Yes | 

| 
11 | 
Stockout | 
No | 

| 
13 | 
Lost shipment | 
Yes | 

| 
14 | 
Redirected | 
No | 

| 
15 | 
Deleted | 
Yes | 

| 
16 | 
Warehouse Ruse | 
No | 

| 
17 | 
Returning | 
No | 

| 
18 | 
Scanned Waybill | 
No | 

| 
19 | 
Packed | 
No | 

| 
20 | 
Information received | 
No | 

| 
21 | 
Awaiting pickup | 
No | 

| 
22 | 
Insufficient data - AWB not created | 
No | 

| 
23 | 
Information sent to warehouse | 
No | 

| 
24 | 
Compensation paid | 
Yes | 

| 
25 | 
Claim opened | 
Yes | 

| 
26 | 
Warehouse | 
No | 

| 
27 | 
Damaged shipment | 
Yes | 

| 
28 | 
PreAlert | 
No | 

| 
29 | 
Destroyed | 
Yes | 

| 
30 | 
Warehouse Budapest | 
No | 

| 
31 | 
Lastmile Accept | 
No | 

| 
32 | 
Warehouse Sofia | 
No | 

| 
33 | 
Warehouse Zagreb | 
No | 

| 
34 | 
Returned to Warehouse | 
Yes | 

| 
35 | 
Rejected by courier | 
Yes | 

| 
36 | 
Returned to Client | 
Yes | 

| 
37 | 
Оn hold | 
No | 

| 
38 | 
Cancel | 
No | 

| 
39 | 
Warehouse Oradea | 
No | 

| 
40 | 
Wrong recipient data | 
No | 

| 
41 | 
Linhaul transit | 
No | 

| 
42 | 
Product returned to stock | 
Yes | 

| 
43 | 
Insufficient data | 
No | 

| 
44 | 
Unsuccessful delivery attempt | 
No | 

| 
45 | 
Warehouse Senec | 
No | 

| 
46 | 
Warehouse Budapest E | 
No | 

| 
47 | 
Warehouse Pickup | 
No | 

| 
48 | 
Warehouse Webshippy | 
No | 

| 
49 | 
Linehaul loading | 
No | 

| 
50 | 
Warehouse Ljubljana | 
No | 

| 
51 | 
Picked up | 
No | 

| 
52 | 
Search cancelled | 
No | 

| 
53 | 
Underaudit | 
No | 

| 
54 | 
COD Blocked by Authorities | 
No | 

| 
55 | 
Loaded hub Ruse (BG) | 
No | 

| 
56 | 
Loaded hub Sofia (BG) | 
No | 

| 
57 | 
Loaded hub Oradea (RO) | 
No | 

| 
58 | 
Loaded hub Zagreb (HR) | 
No | 

| 
59 | 
Loaded hub Senec (SK) | 
No | 

| 
60 | 
Unloaded hub Ruse (BG) | 
No | 

| 
61 | 
Unloaded hub Sofia (BG) | 
No | 

| 
62 | 
Unloaded hub Oradea (RO) | 
No | 

| 
63 | 
Unloaded hub Zagreb (HR) | 
No | 

| 
64 | 
Unloaded hub Senec (SK) | 
No | 

| 
65 | 
Loaded hub Ljubljana (SI) | 
No | 

| 
66 | 
Unloaded hub Ljubljana (SI) | 
No | 

| 
67 | 
Under investigation | 
No | 

| 
68 | 
Warehouse Bolzano | 
No | 

| 
69 | 
Loaded hub Bolzano (IT) | 
No | 

| 
70 | 
Unloaded hub Bolzano (IT) | 
No | 

| 
71 | 
Warehouse Castellbisbal | 
No | 

| 
72 | 
Loaded hub Castellbisbal (ES) | 
No | 

| 
73 | 
Unloaded hub Castellbisbal (ES) | 
No | 

| 
74 | 
Repackaged | 
No | 

| 
75 | 
Warehouse Burgas | 
No | 

| 
76 | 
Loaded hub Burgas (BG) | 
No | 

| 
77 | 
Unloaded hub Burgas (BG) | 
No | 

| 
78 | 
Loaded hub Buda (HU) | 
No | 

| 
79 | 
Unloaded hub Buda (HU) | 
No | 

| 
80 | 
Warehouse Vienna | 
No | 

| 
81 | 
Loaded hub Vienna (AT) | 
No | 

| 
82 | 
Unloaded hub Vienna (AT) | 
No | 

| 
86 | 
Warehouse Montana | 
No | 

| 
87 | 
Loaded hub Montana (BG) | 
No | 

| 
88 | 
Unloaded hub Montana (BG) | 
No | 

| 
89 | 
Warehouse Istanbul | 
No | 

| 
90 | 
Loaded hub Istanbul (TR) | 
No | 

| 
91 | 
Unloaded hub Istanbul (TR) | 
No | 

| 
92 | 
Loaded hub Budapest (HU) | 
No | 

| 
93 | 
Unloaded hub Budapest (HU) | 
No | 

**StatusesHistory (Data Structure)**

| 
Field | 
Description | 

| 
ID | 
Record identifier. | 

| 
STATUS | 
Status text (e.g. In Transit, On delivery etc) | 

| 
DATE | 
Status date | 

| 
DATE_CREATED | 
The date the record was created | 

| 
COMMENT | 
The name of the status in the native language for every country. | 

| 
PARTNER_VOUCHER | 
Partner voucher / last-mile tracking number related to the status record (null if not applicable). | 

**Example:**

[
  {
    "refNum": "5420122",
    "awb": null,
    "newReturnNumber": null,
    "error": null,
    "errorCode": null,
    "statusesHistory": [
      {
        "ID": 26332,
        "STATUS": "Information received",
        "DATE": "2020-03-06 10:47:18",
        "DATE_CREATED": "2020-03-06 10:47:18",
        "COMMENT": null,
        "PARTNER_VOUCHER": null
      }
    ],
    "items": [
      {
        "refNumber": "ref-test-54202",
        "sn": null,
        "qty": 2
      }
    ]
  },
  {
    "refNum": "21555",
    "awb": "00228876896",
    "newReturnNumber": "00228976899",
    "error": null,
    "errorCode": null,
    "statusesHistory": [
      {
        "ID": 26332,
        "STATUS": "Information received",
        "DATE": "2020-03-06 10:47:18",
        "DATE_CREATED": "2020-03-06 10:47:18",
        "COMMENT": null,
        "PARTNER_VOUCHER": null
      }
    ],
    "items": [
      {
        "refNumber": "ref-test-54201",
        "sn": "SN0001234",
        "qty": 1
      }
    ]
  },
  {
    "refNum": "TEST488",
    "awb": null,
    "error": "Not found order with specified reference number!",
    "errorCode": 404,
    "statusesHistory": [],
    "items": []
  },
  {
    "refNum": "55555555555555555555",
    "awb": null,
    "error": "Not found order with specified reference number!",
    "errorCode": 404,
    "statusesHistory": [],
    "items": []
  }
]

`

**HTTP Errors:**

| 
**Code** | 
**Description** | 

| 
200 | 
Order information returned successfully. | 

| 
400 | 
Bad request. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
404 | 
Not found record. | 

| 
422 | 
Wrong params. | 

| 
500 | 
Internal Server Error / This action is unauthorized. |

Request body:
```json
{
	"testMode": 0,
	"orders": [
		{
			"refNum": "Order #320"
		}, 
		{
			"refNum": "123"
		},
		{
			"refNum": "TEST488"
		},
		{
			"refNum": "55555555555555555555"
		}
	]
}
```


---
### Product_Creation_Web_Service-v1.1

`POST https://api1.inout.bg/api/v1/fulfilment/create-product`


We can now offer you the ability to ask product creation from your company's software or website by taking advantage of "Product Creation Web Service".

**Requirements**

| 
**API Endpoint** | 
**Description** | 

| 
/fulfilment/create-product | 
Creating a product in our fulfilment system. | 

Method: POST
Authorization: Bearer API_TOKEN
Body (JSON)

**Example URLs:**

| 
**Environment** | 
**URL** | 

| 
Test | 
https://test-api.inout.bg/api/v1/fulfilment/create-product | 

| 
Production | 
https://api1.inout.bg/api/v1/fulfilment/create-product | 

**API Call Input Fields**

| 
**parameter** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
testMode | 
bool | 
yes | 
 | 
if you want to use the API only for tests set this field to true. Applies only to the production environment. On the test environment, all shipments save on test env. | 

| 
companyId | 
integer | 
yes | 
 | 
ID of company, you can receive it from the „Companies Web Service". | 

| 
**product** | 
object | 
yes | 
 | 
 | 

| 
name | 
string | 
yes | 
MaxLength: 200 | 
Product name. | 

| 
barcode | 
string | 
yes | 
MaxLength: 50 | 
Product barcode e.g - 5439636114211. | 

| 
refNumber | 
string | 
yes | 
MaxLength: 100 | 
Product reference number. | 

| 
description | 
text | 
no | 
MaxLength: 500 | 
Product description. | 

| 
length | 
numeric(15.2) | 
yes | 
Min: 0.1, Max: 999 | 
Product length in cm. | 

| 
width | 
numeric(15.2) | 
yes | 
Min: 0.1, Max: 999 | 
Product width in cm. | 

| 
height | 
numeric(15.2) | 
yes | 
Min: 0.1, Max: 999 | 
Product height in cm. | 

| 
weight | 
numeric(15.2) | 
yes | 
Min: 0.01, Max: 999 | 
Product weight in kg. | 

| 
hsCode | 
string | 
no | 
 | 
HS Code. Stored as sent; not validated by the application. | 

**Important!**
The barcode is checked across our entire system, not only among your own products. If the barcode you send is already used by another product (any company), the request is rejected with a 422 error (see below) and no product is created. The reference number (refNumber), on the other hand, is checked only within your own company: sending a refNumber that already exists for your company is also rejected with a 422 error, so resending the same create-product request never creates a duplicate product for the same company.
In the rare case a barcode passes the initial uniqueness check but still collides at database level (e.g. a race condition), the product is created anyway, just without a barcode attached.

**Example**:

{
    "testMode": true,
    "companyId": 332,
    "product": {
        "name": "test product",
        "barcode": "bb-test-54202",
        "refNumber": "ref-test-54202",
        "description": "test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test",
        "length": 20.5,
        "width": 20.5,
        "height": 20.5,
        "weight": 2.2,
        "hsCode": "640399.30.00"
    }
}

`

**API Response (Output Fields)**

| 
**Field** | 
**Description** | 

| 
productId | 
ID of the created product (null on error). | 

| 
error | 
false on success, or the text of the error while executing the web service from the server-side. | 

**Example:**

{
  "productId": 85,
  "error": false
}

`

**HTTP Errors:**

| 
**Code** | 
**Description** | 

| 
201 | 
The product was created successfully. | 

| 
400 | 
Bad request. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
422 | 
Wrong params, or duplicate barcode: {"productId": null, "error": "This barcode is not unique for our system: ()"}, or duplicate reference number: {"productId": null, "error": "The product with reference number  already exists. The reference number must be a unique value."} | 

| 
500 | 
Internal Server Error / This action is unauthorized. |

Request body:
```json
{
    "testMode": 0,
    "companyId": 333,
    "product": {
        "name": "test product",
        "barcode": "bb-test-54202",
        "refNumber": "ref-test-54202",
        "barcodeType": "EAN-13",
        "description": "test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test decsription test",
        "length": 20.5,
        "width": 20.5,
        "height": 20.5,
        "weight": 2.2,
        "hsCode": "640399.30.00"
    }
}
```


---
### Booking_Request_Creation_Web_Service-v1.1

`POST https://api1.inout.bg/api/v1/fulfilment/create-request`


We can now offer you the ability to create a booking request from your company's software or website by taking advantage of "Booking Request Creation Web Service".

**Requirements**

| 
**API Endpoint** | 
**Description** | 

| 
/fulfilment/create-request | 
Creating a booking request in our fulfilment system. | 

Method: POST
Authorization: Bearer API_TOKEN
Body (JSON)

**Example URLs:**

| 
**Environment** | 
**URL** | 

| 
Test | 
https://test-api.inout.bg/api/v1/fulfilment/create-request | 

| 
Production | 
https://api1.inout.bg/api/v1/fulfilment/create-request | 

**Changelog**

| 
**Version** | 
**Change** | 

| 
v1.1 (October 2026) | 
Added optional client reference fields: clientReference, ref1, ref2, ref3. They are stored with the booking request and returned verbatim by the "Request Status Web Service" and the "Booking Request Status Web Service". Existing integrations are not affected. | 

**API Call Input Fields**

| 
**parameter** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
testMode | 
bool | 
yes | 
 | 
if you want to use the API only for tests set this field to true. Applies only to the production environment. On the test environment, all shipments save on test env. | 

| 
companyId | 
integer | 
yes | 
 | 
ID of company, you can receive it from the „Companies Web Service". | 

| 
warehouseId | 
integer | 
yes | 
 | 
ID of warehouse you want to send a Request to. Your company must have access to this warehouse. | 

| 
courierInc | 
string | 
no | 
MaxLength: 50. If sent, cannot be empty. | 
Incoming courier name. Empty string is rejected with "Courier name is invalid". | 

| 
trackNumb | 
string | 
no | 
MaxLength: 50. If sent, cannot be empty. | 
Incoming tracking number. Empty string is rejected with "Tracking number is invalid". | 

| 
deliveryDate | 
date | 
no | 
Format: Y-m-d. Today or later. | 
Expected delivery date of the incoming shipment. | 

| 
packagesCount | 
integer | 
no | 
Min: 1. If sent, cannot be empty/0. | 
Number of packages of the incoming shipment. 0 or empty is rejected with "Package count is invalid". | 

| 
clientReference | 
string | 
no | 
MaxLength: 100. Printable ASCII only. | 
Your own primary identifier of the booking request (e.g. your purchase order / inbound document number). Stored as received and returned by both status services. | 

| 
ref1 | 
string | 
no | 
MaxLength: 100. Printable ASCII only. | 
Free-text reference 1. No meaning on our side; stored as received and returned by both status services. | 

| 
ref2 | 
string | 
no | 
MaxLength: 100. Printable ASCII only. | 
Free-text reference 2. Same rules as ref1. | 

| 
ref3 | 
string | 
no | 
MaxLength: 100. Printable ASCII only. | 
Free-text reference 3. Same rules as ref1. | 

| 
**products** | 
Array of objects | 
yes | 
Min: 1 element. | 
Products included in the Request. | 

| 
refNumber | 
string | 
yes | 
 | 
Reference number of the product. Must be a product that already belongs to your company. | 

| 
quantity | 
integer | 
yes | 
Min: 1 | 
Product quantity. | 

**Client reference fields (clientReference, ref1, ref2, ref3) - rules**

- Optional. If the key is omitted, sent as `null` or sent as an empty string, the value is stored as null and returned as `null`.

- Printable ASCII only (space to `~`: letters, digits, punctuation). Accented or Cyrillic characters, tabs, line breaks and emoji are rejected with HTTP 400: "The ref1 may contain only printable ASCII characters (letters, digits, punctuation)."

- Longer than 100 characters, or not a string (number, array, object), is rejected with HTTP 400, e.g. "The ref1 may not be greater than 100 characters."

- Leading and trailing whitespace is trimmed before storing.

- Stored once at creation. They cannot be changed afterwards through the API.

- Not searchable and not unique: there is no lookup by clientReference, and two booking requests may carry the same value.

- Not shown in the client cabinet; they are available only through the API status services.

**Important!**
If the same refNumber appears more than once in the products array, the duplicate lines are merged into a single line and their quantities are summed.

**Example**:

{
    "testMode": true,
    "companyId": 332,
    "warehouseId": 1,
    "courierInc": "DHL",
    "trackNumb": "1234567890",
    "deliveryDate": "2026-10-20",
    "packagesCount": 3,
    "clientReference": "PO-2026-0042",
    "ref1": "Supplier: ACME GmbH",
    "ref2": "Dock 3",
    "ref3": null,
    "products": [
        {
            "refNumber": "ref-test-54202",
            "quantity": 10
        },
        {
            "refNumber": "ref-test-54201",
            "quantity": 100
        }
    ]
}

`

**API Response (Output Fields)**

| 
**Field** | 
**Description** | 

| 
requestId | 
ID of the created Request. | 

| 
error | 
A field that contains the text from a possible error while executing the web service from the server-side. | 

**Example:**

{
    "requestId": 137
}

`

**Related services:**
Once you have a requestId, you can check it with the "Request Status Web Service" (GET /api/v1/fulfilment/get-request-status/{id}) or receive the full lifecycle and product breakdown with the "Booking Request Status Web Service" (POST /api/v1/fulfilment/booking-request-status). Both return the clientReference, ref1, ref2 and ref3 values exactly as you sent them.

**HTTP Errors:**

| 
**Code** | 
**Description** | 

| 
201 | 
The Request was created successfully. | 

| 
400 | 
Bad request / validation error, e.g. "The ref1 may not be greater than 100 characters." or "The ref1 may contain only printable ASCII characters (letters, digits, punctuation)." | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
422 | 
Wrong params, or one of the following: "Courier name is invalid" / "Tracking number is invalid" / "Package count is invalid" / "The company ID you added in Request does not exist. Please check it!" / "You don't have access to this warehouse. Please check warehouseId in your Request!" / "The selected products reference numbers is invalid. Please check following Product's Ref Numbers: " / "Error when saving Request information!" | 

| 
500 | 
Internal Server Error / This action is unauthorized. |

Request body:
```json
{
    "testMode": true,
    "companyId": 332,
    "warehouseId": 1,
    "courierInc": "DHL",
    "trackNumb": "1234567890",
    "deliveryDate": "2026-10-20",
    "packagesCount": 3,
    "clientReference": "PO-2026-0042",
    "ref1": "Supplier: ACME GmbH",
    "ref2": "Dock 3",
    "ref3": null,
    "products": [
        {
            "refNumber": "ref-test-54202",
            "quantity": 10
        },
        {
            "refNumber": "ref-test-54201",
            "quantity": 100
        }
    ]
}
```


---
### Product_Availability_Web_Service-v1.0

`GET https://api1.inout.bg/api/v1/fulfilment/get-prod-avails`


We can now offer you the ability to check your products' available quantities from your company's software or website by taking advantage of "Product Availability Web Service".

**Requirements**

| 
**API Endpoint** | 
**Description** | 

| 
/fulfilment/get-prod-avails | 
Receiving the available quantities of your products, per warehouse. | 

Method: GET
Authorization: Bearer API_TOKEN

**Example URLs:**

| 
**Environment** | 
**URL** | 

| 
Test | 
https://test-api.inout.bg/api/v1/fulfilment/get-prod-avails | 

| 
Production | 
https://api1.inout.bg/api/v1/fulfilment/get-prod-avails | 

**API Call Input Fields**

This service takes no input parameters. The results are automatically filtered to the companies linked to your API token.

**API Response (Output Fields)**

The response is a JSON array with one row per product per warehouse.

| 
**Field** | 
**Description** | 

| 
AVAIL_DATE | 
Date/time of the availability snapshot. | 

| 
STORE_NAME | 
Name of the warehouse. | 

| 
ART_NAME | 
Product name. | 

| 
ART_LNG_DESC | 
Product long description. | 

| 
ART_SH_DESC | 
Product short description. | 

| 
CUST_NAME | 
Your company name. | 

| 
REFERENCE_NUMBER | 
Your product reference number (SKU). | 

| 
COURIER_ITEM_CODE | 
Internal item code. | 

| 
AVAIL_QTY | 
Available quantity in the warehouse. | 

**Example:**

[
  {
    "AVAIL_DATE": "2026-07-08 06:00:00",
    "STORE_NAME": "Warehouse Ruse",
    "ART_NAME": "test product",
    "ART_LNG_DESC": "test product long description",
    "ART_SH_DESC": "test product",
    "CUST_NAME": "Test Company Ltd.",
    "REFERENCE_NUMBER": "ref-test-54202",
    "COURIER_ITEM_CODE": "12345",
    "AVAIL_QTY": 87
  }
]

`

**HTTP Errors:**

| 
**Code** | 
**Description** | 

| 
200 | 
Availability information returned successfully. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
500 | 
Internal Server Error / This action is unauthorized. |


---
### Order_Deletion_Web_Service-v1.0

`DELETE https://api1.inout.bg/api/v1/orders-delete/CCS-03207-CZ`


We can now offer you the ability to delete a fulfilment order directly from your company's software or website by taking advantage of "Order Deletion Web Service".

Description:
With this service, you can delete an order that has not been processed yet. An order can be deleted only while it is in one of the statuses **Information received**, **Awaiting pickup** or **New**, and only if it is **not older than 14 days**. Only orders belonging to your companies can be deleted.

**Requirements**

| 
**API Endpoint** | 
**Description** | 

| 
/orders-delete/{refNumber} | 
Deleting a fulfilment order by your own reference number. | 

| 
/orders/{id} | 
Alternative: deleting a fulfilment order by the internal order id, returned by the "Order Creation Web Service". | 

**Method: DELETE
Authorization: Bearer API_TOKEN
API Call Input Fields
URL path parameters**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
refNumber | 
string | 
yes | 
 | 
Your own reference number of the order - the value you filled in when creating the order. Used with /orders-delete/{refNumber}. | 

| 
id | 
integer | 
yes | 
 | 
The internal order id, returned by the "Order Creation Web Service". Used with the alternative endpoint /orders/{id}. | 

**Example**:

Test - https://test-api.inout.bg/api/v1/orders-delete/CCS-03207-CZ

Production - https://api1.inout.bg/api/v1/orders-delete/CCS-03207-CZ

Alternative (by internal order id):

Test - https://test-api.inout.bg/api/v1/orders/137

Production - https://api1.inout.bg/api/v1/orders/137

**API Response (Output Fields)**

| 
**Field** | 
**Description** | 

| 
error | 
false if the order was deleted successfully. | 

| 
message | 
Text result of the operation or a possible error while executing the web service from the server-side. | 

| 
code | 
HTTP code of the operation. | 

| 
result | 
Only for the alternative endpoint /orders/{id} - object with basic data of the deleted order. | 

**Example** (/orders-delete/{refNumber}):

{
    "error": false,
    "message": "The order was deleted successfully.",
    "code": 200
}

`

**Example** (/orders/{id}):

{
    "error": false,
    "message": "The order was deleted successfully.",
    "result": {
        "ID": 137,
        "OP_OUR_STATUS_ID": 20,
        "OP_CUSTOMER_ID": 332,
        "ORDER_ID": "1005",
        "OP_WAYBILL_BG": "CCS-03207-CZ",
        "OP_DATE": "2026-07-01 10:15:00"
    },
    "code": 200
}

`

HTTP Errors:

| 
**Code** | 
**Description** | 

| 
200 | 
The order was deleted successfully. | 

| 
400 | 
The order cannot be deleted. - the order is not in status Information received / Awaiting pickup / New, is older than 14 days, or does not belong to your companies. | 

| 
400 | 
The order ref number is required. / The order id must be a number. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
404 | 
The order does not exist. (alternative endpoint /orders/{id}) | 

| 
500 | 
Error deleting order! |


---
### Product_List_Web_Service-v1.0

`GET https://api1.inout.bg/api/v1/fulfilment/get-products?companyId=332`


We can now offer you the ability to receive a list of all your products in our fulfilment system directly from your company's software or website by taking advantage of "Product List Web Service".

Description:
With this service, you can receive all products registered in our fulfilment system for one of your companies. The products are the ones created via the "Product Creation Web Service" or in the client cabinet.

**Requirements**

| 
**API Endpoint** | 
**Description** | 

| 
/fulfilment/get-products | 
Receiving a list of all products of a company in our fulfilment system. | 

**Method: GET
Authorization: Bearer API_TOKEN
API Call Input Fields
URL query parameters**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
companyId | 
integer | 
yes | 
Must be one of your companies. | 
ID of company, you can receive it from the „Companies Web Service“. | 

**Example**:

Test - https://test-api.inout.bg/api/v1/fulfilment/get-products?companyId=332

Production - https://api1.inout.bg/api/v1/fulfilment/get-products?companyId=332

**API Response (Output Fields)**

The response is a JSON array of products. Each product contains:

| 
**Field** | 
**Description** | 

| 
ID | 
ID of the product in our system. | 

| 
NAME | 
Product name. | 

| 
DESCRIPTION | 
Product description. | 

| 
LENGTH_ITEM | 
Product length in cm. | 

| 
WIDTH | 
Product width in cm. | 

| 
HEIGHT | 
Product height in cm. | 

| 
WEIGHT | 
Product weight in kg. | 

| 
REFERENCE_NUMBER | 
Product reference number - the value you filled in when creating the product. | 

**Example:**

[
    {
        "ID": 85,
        "NAME": "test product",
        "DESCRIPTION": "test description",
        "LENGTH_ITEM": "20.50",
        "WIDTH": "20.50",
        "HEIGHT": "20.50",
        "WEIGHT": "2.20",
        "REFERENCE_NUMBER": "ref-test-54202"
    },
    {
        "ID": 86,
        "NAME": "test product 2",
        "DESCRIPTION": null,
        "LENGTH_ITEM": "10.00",
        "WIDTH": "15.00",
        "HEIGHT": "5.00",
        "WEIGHT": "0.50",
        "REFERENCE_NUMBER": "ref-test-54201"
    }
]

`

HTTP Errors:

| 
**Code** | 
**Description** | 

| 
200 | 
Returns result from the web service. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
422 | 
Validation error - the companyId parameter is missing or does not exist. | 

| 
503 | 
You do not have access to specified company. |


---
### Request_Status_Web_Service-v1.1

`GET https://api1.inout.bg/api/v1/fulfilment/get-request-status/137`


We can now offer you the ability to check the status of a booking request directly from your company's software or website by taking advantage of "Request Status Web Service".

Description:
With this service, you can check whether a booking request, created via the "Booking Request Creation Web Service", has already been accepted (confirmed) at our warehouse. In the "id" parameter, fill the "requestId" value you received when creating the booking request.

**Requirements**

| 
**API Endpoint** | 
**Description** | 

| 
/fulfilment/get-request-status/{id} | 
Checking the confirmation status of a booking request in our fulfilment system. | 

**Method: GET
Authorization: Bearer API_TOKEN
API Call Input Fields
URL path parameters**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
id | 
integer | 
yes | 
Must be a Request of one of your companies. | 
ID of Request - the "requestId" value returned by the "Booking Request Creation Web Service". | 

**Changelog**

| 
**Version** | 
**Change** | 

| 
v1.1 (October 2026) | 
The response now also returns the client reference fields clientReference, ref1, ref2 and ref3 supplied when the booking request was created. They are returned in both the confirmed and the not-confirmed response. Existing integrations are not affected. | 

**Example**:

Test - https://test-api.inout.bg/api/v1/fulfilment/get-request-status/137

Production - https://api1.inout.bg/api/v1/fulfilment/get-request-status/137

**API Response (Output Fields)**

| 
**Field** | 
**Description** | 

| 
accepted | 
true if the Request has been confirmed at our warehouse, false if it is not confirmed yet. | 

| 
date | 
The date on which the Request was confirmed. Returned only when "accepted" is true. | 

| 
clientReference | 
Your own identifier of the booking request, exactly as sent in the "Booking Request Creation Web Service". null if it was not sent. | 

| 
ref1 | 
Free-text reference 1, exactly as sent at creation. null if it was not sent. | 

| 
ref2 | 
Free-text reference 2, exactly as sent at creation. null if it was not sent. | 

| 
ref3 | 
Free-text reference 3, exactly as sent at creation. null if it was not sent. | 

**Example** (confirmed Request):

{
    "accepted": true,
    "date": "2026-07-01 10:15:33",
    "clientReference": "PO-2026-0042",
    "ref1": "Supplier: ACME GmbH",
    "ref2": "Dock 3",
    "ref3": null
}

`

**Example** (not confirmed yet):

{
    "accepted": false,
    "clientReference": "PO-2026-0042",
    "ref1": "Supplier: ACME GmbH",
    "ref2": "Dock 3",
    "ref3": null
}

`

**Example** (Request created without references):

{
    "accepted": false,
    "clientReference": null,
    "ref1": null,
    "ref2": null,
    "ref3": null
}

`

HTTP Errors:

| 
**Code** | 
**Description** | 

| 
200 | 
Returns result from the web service. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
422 | 
Wrong Request ID! - the Request does not exist or does not belong to your companies. Both cases return the same message on purpose. | 

| 
500 | 
Internal Server Error / This action is unauthorized. |


---
### Booking_Request_Status_Web_Service-v1.1

`POST https://api1.inout.bg/api/v1/fulfilment/booking-request-status`


We can now offer you the ability to receive detailed information about a booking request directly from your company's software or website by taking advantage of "Booking Request Status Web Service".

Description:
With this service, you can receive the full lifecycle of a booking request (created, received at the warehouse, closed/confirmed, deleted) together with a product-by-product breakdown of the booked and accepted quantities. In the "bookingId" parameter, fill the "requestId" value you received when creating the booking request via the "Booking Request Creation Web Service".

**Requirements**

| 
**API Endpoint** | 
**Description** | 

| 
/fulfilment/booking-request-status | 
Receiving detailed statuses and product quantities of a booking request in our fulfilment system. | 

**Method: POST
Authorization: Bearer API_TOKEN
API Call Input Fields
Body (JSON)**

| 
**parameter** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
companyId | 
integer | 
yes | 
Must be one of your companies. | 
ID of company, you can receive it from the „Companies Web Service“. | 

| 
bookingId | 
integer | 
yes | 
 | 
ID of the booking request - the "requestId" value returned by the "Booking Request Creation Web Service". | 

**Changelog**

| 
**Version** | 
**Change** | 

| 
v1.1 (October 2026) | 
The response now also returns the client reference fields clientReference, ref1, ref2 and ref3 supplied when the booking request was created. They are placed directly after bookingId; statuses and products are unchanged. Existing integrations are not affected. | 

**Example**:

Test - https://test-api.inout.bg/api/v1/fulfilment/booking-request-status

Production - https://api1.inout.bg/api/v1/fulfilment/booking-request-status

{
    "companyId": 332,
    "bookingId": 137
}

`

**API Response (Output Fields)**

| 
**Field** | 
**Description** | 

| 
bookingId | 
ID of the booking request from your request. | 

| 
clientReference | 
Your own identifier of the booking request, exactly as sent in the "Booking Request Creation Web Service". null if it was not sent. | 

| 
ref1 | 
Free-text reference 1, exactly as sent at creation. null if it was not sent. | 

| 
ref2 | 
Free-text reference 2, exactly as sent at creation. null if it was not sent. | 

| 
ref3 | 
Free-text reference 3, exactly as sent at creation. null if it was not sent. | 

| 
statuses | 
Object with the dates of each stage of the booking request. Each date is null until the stage is reached. | 

| 
statuses.created | 
Date on which the booking request was created. | 

| 
statuses.received | 
Date on which the goods arrived at our warehouse. | 

| 
statuses.closed | 
Date on which the booking request was confirmed (closed). | 

| 
statuses.deleted | 
Date on which the booking request was deleted, if it was deleted. | 

| 
products | 
Array with the products of the booking request. | 

| 
products.name | 
Product name. | 

| 
products.referenceNumber | 
Product reference number. | 

| 
products.booked | 
Quantity you booked in the request. | 

| 
products.accepted | 
Quantity actually accepted at our warehouse. null until the booking request is confirmed. | 

| 
products.comment | 
Comment/reason from our warehouse for this product (e.g. in case of a quantity difference). | 

**Example:**

{
    "bookingId": 137,
    "clientReference": "PO-2026-0042",
    "ref1": "Supplier: ACME GmbH",
    "ref2": "Dock 3",
    "ref3": null,
    "statuses": {
        "created": "2026-06-25 09:41:12",
        "received": "2026-06-27 14:02:55",
        "closed": "2026-06-28 10:15:33",
        "deleted": null
    },
    "products": [
        {
            "name": "test product",
            "referenceNumber": "ref-test-54202",
            "booked": 10,
            "accepted": 10,
            "comment": null
        },
        {
            "name": "test product 2",
            "referenceNumber": "ref-test-54201",
            "booked": 100,
            "accepted": 98,
            "comment": "2 damaged items"
        }
    ]
}

`

A booking request created without references returns all four reference fields as `null`.

HTTP Errors:

| 
**Code** | 
**Description** | 

| 
200 | 
Returns result from the web service. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
404 | 
Booking request not found | 

| 
422 | 
Bad request - the companyId or bookingId parameter is missing. | 

| 
422 | 
Customer not found / User cannot manage customer - the companyId does not exist or is not one of your companies. | 

| 
500 | 
Internal Server Error / This action is unauthorized. |

Request body:
```json
{
    "companyId": 332,
    "bookingId": 137
}
```


---
### Transfer_Creation_Web_Service-v1.0

`POST https://api1.inout.bg/api/v1/fulfilment/create-transfer`


We can now offer you the ability to create a warehouse transfer protocol from your company's software or website by taking advantage of "Transfer Creation Web Service".

**Requirements**

| 
**API Endpoint** | 
**Description** | 

| 
/fulfilment/create-transfer | 
Creating a warehouse transfer protocol (stock movement between two warehouses, or a scrap protocol) in our fulfilment system. | 

Method: POST
Authorization: Bearer API_TOKEN
Body (JSON)

**Example URLs:**

| 
**Environment** | 
**URL** | 

| 
Test | 
https://test-api.inout.bg/api/v1/fulfilment/create-transfer | 

| 
Production | 
https://api1.inout.bg/api/v1/fulfilment/create-transfer | 

**API Call Input Fields**

| 
**parameter** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
testMode | 
bool | 
yes | 
 | 
if you want to use the API only for tests set this field to true. Applies only to the production environment. On the test environment, all transfers save on test env. `true` validates the whole payload end-to-end and persists nothing. | 

| 
companyId | 
integer | 
yes | 
 | 
ID of company, you can receive it from the „Companies Web Service". Must be accessible to your token (partner/cabinet scope; admin tokens may use any). | 

| 
sourceWarehouseId | 
integer | 
yes | 
 | 
ID of the sending warehouse. You can receive it from the „Warehouses List Web Service" (field `data[].id`). | 

| 
destinationWarehouseId | 
integer | 
no | 
 | 
ID of the receiving warehouse, you can receive it from the „Warehouses List Web Service" (field `data[].id`). If sent, must differ from sourceWarehouseId, otherwise rejected. | 

| 
protocolType | 
integer | 
no | 
Default: 1 | 
1 = NORMAL, 3 = SCRAP. 2 (EMAG/Skroutz) is admin-only; requested by a non-admin token it is rejected with PROTOCOL_TYPE_NOT_ALLOWED. | 

| 
needCheck | 
bool | 
no | 
 | 
Requires scanning in the warehouse. | 

| 
comments | 
string | 
no | 
 | 
Free-text note. | 

| 
receiver | 
string | 
no | 
 | 
Receiver text (store unit). | 

| 
waybill | 
string | 
no | 
 | 
Waybill number. | 

| 
instructions | 
string | 
no | 
 | 
Free-text instructions. | 

| 
externalRef | 
string | 
yes | 
MaxLength: 100 | 
Idempotency key, unique per companyId. Required for the API only (manual/UI/Excel-import transfers don't use it) — see Important notes below. | 

| 
**items** | 
Array of objects | 
yes | 
Min: 1 element. | 
Transfer lines. | 

| 
refNumber | 
string | 
one of refNumber/barcode | 
 | 
Product reference number. | 

| 
barcode | 
string | 
one of refNumber/barcode | 
 | 
Product barcode. If both refNumber and barcode are sent, refNumber is used to resolve the product (barcode is ignored) — identical to the Excel-import behaviour. | 

| 
quantity | 
integer | 
yes | 
Min: 1 | 
Non-positive or non-integer values are rejected as INVALID_QUANTITY. | 

| 
batchNo | 
string | 
with batchDate | 
 | 
Batch number. Must be sent together with batchDate (or neither) — one without the other is rejected as BATCH_INCOMPLETE. | 

| 
batchDate | 
date | 
with batchNo | 
Format: YYYY-MM-DD | 
Batch date. | 

**Important!**
The protocol date is never taken from the request — the server always sets it to today's date.
Every row is validated (product belongs to the company, item-level stock, per-batch stock) before anything is written — if any single row fails, nothing is persisted (all-or-nothing).
The starting status of the protocol depends on your token's access type: cabinet/client tokens start it at STATUS_CABINET_WAITING (skipping the UI draft step, since the API sends a complete protocol); partner and admin tokens start it with no status set, following the normal manual flow.
Sending the same externalRef again does not create a second protocol — the existing one (including a since-deleted one) is returned with a 409, so retries are always safe.

**Example**:

{
    "testMode": true,
    "companyId": 1075,
    "sourceWarehouseId": 4,
    "destinationWarehouseId": 7,
    "protocolType": 1,
    "needCheck": false,
    "comments": "Transfer to Sofia",
    "receiver": "Store unit 2",
    "waybill": null,
    "instructions": null,
    "externalRef": "ERP-TRX-000123",
    "items": [
        { "refNumber": "4480541734500", "quantity": 1 },
        { "barcode": "449061657", "quantity": 1, "batchNo": "TRTEST01", "batchDate": "2028-10-31" },
        { "refNumber": "449067544700", "barcode": "4490675447", "quantity": 1, "batchNo": "TR3TEST01", "batchDate": "2028-05-31" }
    ]
}

`

**API Response (Output Fields)**

| 
**Field** | 
**Description** | 

| 
protocolId | 
ID of the created transfer protocol. null when testMode is true (validated, not saved), or when the request failed. | 

| 
isConfirmed | 
Reflects the token's access type: cabinet → 1 (STATUS_CABINET_WAITING); partner/admin → null. | 

| 
protocolType | 
Echoes the resolved protocol type (1 or 3; default 1). | 

| 
itemsCreated | 
Number of transfer detail lines created. | 

| 
items | 
Array with the resolved refNumber/barcode, quantity and batchId (null if no batch) actually written for each line. | 

| 
error | 
false on success, or the error identifier/text while executing the web service from the server-side. | 

**Example:**

{
  "protocolId": 98765,
  "isConfirmed": null,
  "protocolType": 1,
  "itemsCreated": 2,
  "items": [
    { "refNumber": "4480541734500", "quantity": 1, "batchId": null },
    { "barcode": "449061657", "quantity": 1, "batchId": 3979 }
  ],
  "error": false
}

`

**Duplicate request (idempotency) — HTTP 409:**
Returned when the same externalRef already exists for this companyId (including a soft-deleted protocol, in which case isDeleted is true). No new protocol is created — the existing one is returned instead.

{
  "error": "DUPLICATE_EXTERNAL_REF",
  "protocolId": 98765,
  "isConfirmed": null,
  "protocolType": 1,
  "externalRef": "ERP-TRX-000123",
  "isDeleted": false
}

`

**Validation error — HTTP 422:**
Nothing is persisted (all-or-nothing). Structural/request-level problems come back under `messages`; per-row problems under `itemErrors`.

{
  "error": "VALIDATION_FAILED",
  "messages": [ "destination warehouse must differ from source" ],
  "itemErrors": [
    { "index": 0, "refNumber": "4480541734500", "error": "INSUFFICIENT_QUANTITY", "available": 8, "requested": 12 },
    { "index": 1, "barcode": "449061657", "error": "PRODUCT_NOT_FOUND_FOR_CUSTOMER" }
  ]
}

`

Per-row error codes (`itemErrors[].error`): PRODUCT_NOT_FOUND_FOR_CUSTOMER (no product with that refNumber/barcode belongs to companyId), INSUFFICIENT_QUANTITY (requested qty exceeds item-level availability; includes available + requested), INSUFFICIENT_BATCH_QUANTITY (requested qty exceeds per-batch stock in the source warehouse, or the batch doesn't exist; includes available + requested).

Structural codes/messages (`messages[]`): INVALID_QUANTITY (quantity missing/zero/fractional/non-numeric), BATCH_INCOMPLETE (batchNo without batchDate or vice versa), PROTOCOL_TYPE_NOT_ALLOWED (protocolType=2 requested by a non-admin token), "destination warehouse must differ from source", "company not accessible for this token".

**HTTP Errors:**

| 
**Code** | 
**Description** | 

| 
201 | 
The transfer protocol was created successfully. | 

| 
400 | 
Bad request. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
409 | 
Duplicate externalRef for this companyId — see "Duplicate request" above; the existing protocol is returned, no new one is created. | 

| 
422 | 
Validation failed — see "Validation error" above for the messages/itemErrors detail. | 

| 
500 | 
Internal Server Error / This action is unauthorized. |

Request body:
```json
{
    "testMode": true,
    "companyId": 1075,
    "sourceWarehouseId": 4,
    "destinationWarehouseId": 7,
    "protocolType": 1,
    "needCheck": false,
    "comments": "Transfer to Sofia",
    "receiver": "Store unit 2",
    "waybill": null,
    "instructions": null,
    "externalRef": "ERP-TRX-000123",
    "items": [
        {
            "refNumber": "4480541734500",
            "quantity": 1
        },
        {
            "barcode": "449061657",
            "quantity": 1,
            "batchNo": "TRTEST01",
            "batchDate": "2028-10-31"
        }
    ]
}
```


---
### Warehouses_List_Web_Service-v1.0

`POST https://api1.inout.bg/api/v1/fulfilment/warehouses`

Headers: Content-Type: application/json


We can now offer you the ability to receive the list of warehouses assigned to your company directly from your company's software or website by taking advantage of "Warehouses List Web Service".

Description:
With this service, you can receive all warehouses in our fulfilment system that are assigned to one of your companies. Use it to obtain the warehouse IDs required by the "Transfer Creation Web Service" — the returned `id` is exactly the value accepted there as `sourceWarehouseId` / `destinationWarehouseId`.

**Requirements**

| 
**API Endpoint** | 
**Description** | 

| 
/fulfilment/warehouses | 
Receiving the list of warehouses assigned to a company in our fulfilment system. | 

Method: POST
Authorization: Bearer API_TOKEN
Body (JSON)

**Example URLs:**

| 
**Environment** | 
**URL** | 

| 
Test | 
https://test-api.inout.bg/api/v1/fulfilment/warehouses | 

| 
Production | 
https://api1.inout.bg/api/v1/fulfilment/warehouses | 

**API Call Input Fields**

| 
**parameter** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
companyId | 
integer | 
yes | 
Positive integer. Must be one of your companies. | 
ID of company, you can receive it from the „Companies Web Service". The same access rule as in the "Transfer Creation Web Service" applies. | 

**Example**:

{
    "companyId": 333
}

`

**API Response (Output Fields)**

| 
**Field** | 
**Description** | 

| 
data | 
Array of warehouses assigned to the company. It can be empty (no warehouse assigned) or contain one or more warehouses, sorted by name. | 

| 
data[].id | 
ID of the warehouse. Use this value as `sourceWarehouseId` / `destinationWarehouseId` in the "Transfer Creation Web Service". | 

| 
data[].name | 
Warehouse name. | 

| 
data[].country.id | 
ID of the warehouse country (as in the „Countries Web Service"). null if not set. | 

| 
data[].country.iso | 
ISO code of the warehouse country. null if not set. | 

| 
data[].country.name | 
Country name in English. null if not set. | 

**Example:**

{
    "data": [
        {
            "id": 1,
            "name": "Warehouse Ruse",
            "country": {
                "id": 2,
                "iso": "BG",
                "name": "Bulgaria"
            }
        }
    ]
}

`

**Validation error — HTTP 422:**

{
    "error": "VALIDATION_FAILED",
    "messages": [ "company not accessible for this token" ]
}

`

Messages (`messages[]`): "companyId is required" (companyId missing, zero, negative or not an integer), "company not accessible for this token" (the company is not one of your companies).

**HTTP Errors:**

| 
**Code** | 
**Description** | 

| 
200 | 
Returns result from the web service. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
422 | 
Validation failed — see "Validation error" above. | 

| 
500 | 
Internal Server Error / This action is unauthorized. |

Request body:
```json
{
    "companyId": 333
}
```


## Additional Web Services



---
### COD_Information_Web_Service_v1.0

`GET https://api1.inout.bg/api/v1/check-cod-by-order/123?testMode=0`


We can now offer you the ability to ask for COD information directly from your company's software or website by taking advantage of "COD Information Web Service".

With this service, you can receive detailed COD information. In the "referenceNumber" URL segment, fill the value you sent in "referenceNumber" when creating the AWB. The value can be an order number, a product number or an invoice number.

**Requirements**

| 
**API Endpoint** | 
**Description** | 

| 
check-cod-by-order/{referenceNumber} | 
Receive COD amount and payout information for the shipment created with the given reference number. | 

**Method: GET**
**Authorization: Bearer API_TOKEN**

**API Call Input Fields**
**URL query parameters**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
testMode | 
boolean | 
yes | 
 | 
If you want to use the API only for tests set this field to true. Applies only to the production environment. On the test environment, all shipments save on test env. | 

**Example URLs:**

Test: https://test-api.inout.bg/api/v1/check-cod-by-order/CCS-03207-CZ?testMode=1
Production: https://api1.inout.bg/api/v1/check-cod-by-order/CCS-03207-CZ?testMode=0

**API Response (Output Fields)**

| 
**Field** | 
**Description** | 

| 
awbNumber | 
AWB number. | 

| 
referenceNumber | 
The value that you filled in "referenceNumber" when creating the AWB. | 

| 
COD | 
COD amount in the country currency. | 

| 
payedNumber | 
The number of the payment protocol with which euShipments paid out the COD to you. Null until the COD has been paid out. | 

| 
payedDate | 
The date on which the COD payout was made. Null until the COD has been paid out. | 

**Example:**

{
  "awbNumber": "40695693257",
  "referenceNumber": "CCS-03207-CZ",
  "COD": "2310.00",
  "payedNumber": 10793,
  "payedDate": "2019-05-20 13:40:51"
}

`

**Important - not-found behavior:** if no shipment matches the reference number, or the shipment was not created with your API token, the service does NOT return an HTTP error. It responds with HTTP 200 and an empty (null) body. Always check that the response body actually contains data before processing it.

**Note:** "payedNumber" and "payedDate" are null while the COD has not yet been paid out. A response with these two fields set to null therefore means "COD collected/registered but not paid out yet", not an error.

**HTTP Errors:**

| 
**Code** | 
**Description** | 

| 
200 | 
Returns result from the web service. Also returned with an empty (null) body when no data was found for the reference number (see the not-found behavior above). | 

| 
400 | 
Bad request. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
500 | 
Internal Server Error / This action is unauthorized. |


---
### Phone_Call_History_Web_Service_v1.0

`GET https://api1.inout.bg/api/v1/check-actions/{AWBNumber}?testMode=0`


We can now offer you the ability to ask for a phone call history directly from your company's software or website by taking advantage of "Phone Call History Web Service".

**Requirements:**

| 
**API Endpoint** | 
**Description** | 

| 
check-actions/{AWBNumber} | 
With this service, you can receive the call history from our call centre for the chosen shipment. | 

**Method: GET**
**Authorization: Bearer API_TOKEN**

**API Call Input Fields**
**URL query parameters**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
testMode | 
boolean | 
yes | 
 | 
If you want to use the API only for tests set this field to true. Applies only to the production environment. On the test environment, all shipments save on test env. | 

**Example URLs:**

Test: https://test-api.inout.bg/api/v1/check-actions/64506083?testMode=1
Production: https://api1.inout.bg/api/v1/check-actions/64506083?testMode=0

**API Response (Output Fields)**

| 
**Field** | 
**Description** | 

| 
actions | 
Array with the actions history of the chosen shipment, ordered by date ascending. | 

| 
ID | 
The ID of the call record. | 

| 
ACTION | 
The action that was taken after the call (see the list of possible values below). | 

| 
COMMENT | 
Comment of the person who contacted the recipient. | 

| 
Date | 
The date when the action record was created in our system. Records are returned in ascending order by this field. | 

**Possible ACTION values:**

| 
**ACTION** | 
**Meaning** | 

| 
Return to us | 
The recipient asked for the shipment to be returned to the sender. | 

| 
Organise delivery | 
A delivery (or re-delivery) was arranged with the recipient. | 

| 
New address | 
The recipient provided a new delivery address. | 

| 
Not answers | 
The recipient did not answer the phone call. | 

| 
Destroy it | 
The shipment is to be destroyed. | 

| 
From Import | 
The record was created automatically from an import. | 

| 
Phone call | 
A phone call was made (general contact record). | 

| 
Specified data | 
The recipient specified/confirmed data for the delivery. | 

**Example:**

{
  "actions": [
    {
      "ID": 22083,
      "ACTION": "Return to us",
      "COMMENT": "test",
      "Date": "2019-02-01 12:14:00"
    },
    {
      "ID": 22084,
      "ACTION": "Organise delivery",
      "COMMENT": "ttt",
      "Date": "2019-02-01 12:26:00"
    },
    {
      "ID": 22094,
      "ACTION": "Destroy it",
      "COMMENT": "test",
      "Date": "2019-02-01 15:34:00"
    }
  ]
}

`

**Important - "no actions" behavior:** if the AWB exists but has no phone call actions, the service responds with HTTP 200 and the following body (there is no "actions" field in this case):

{
    "error": "Not found actions to specified AWB!"
}

`

Do not rely only on the HTTP status code - always check whether the response body contains "actions" or "error".

**HTTP Errors:**

| 
**Code** | 
**Description** | 

| 
200 | 
Returns result from the web service. Also returned with {"error": "Not found actions to specified AWB!"} when the AWB has no phone call actions (see above). | 

| 
400 | 
Bad request. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
500 | 
{"error": "Not found AWB!"} - the AWB number does not exist. Note: an unknown AWB currently returns HTTP 500 (not 404). | 

| 
500 | 
Internal Server Error / This action is unauthorized. |


---
### Expedited_Shipments_Web_Service-v1.0

`POST https://api1.inout.bg/api/v1/expedited-shipments`


We can now offer you the ability to declare shipments you have physically expedited (handed over to the courier / shipped out) directly from your company's software, by taking advantage of the "Expedited Shipments Web Service".

Submit the AWB numbers you expedited during the day; each valid, own, non-final shipment gets the "Expedited" status as its current status, and a status-history entry recording who submitted it and when. Invalid, foreign or already-finalized numbers are reported per number, without blocking the rest of the list.

**Requirements**

| 
**API Endpoint** | 
**Description** | 

| 
expedited-shipments | 
Declare a list of AWB numbers as expedited (physically handed over/shipped) by the client. | 

**Method: POST**
**Authorization: Bearer API_TOKEN**

**API Call Input Fields**
**Body (JSON)**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
awbNumbers | 
array of strings | 
yes | 
1 to 500 numbers per request; each number max 50 characters | 
List of AWB numbers you physically expedited. Duplicate numbers in the same list are processed once; empty/blank entries are silently dropped. | 

**Example:**

{
    "awbNumbers": [
        "17502058804253",
        "458121566013",
        "3UW0K2X034483"
    ]
}

`

**Example URLs:**

Test: https://test-api.inout.bg/api/v1/expedited-shipments
Production: https://api1.inout.bg/api/v1/expedited-shipments

**API Response (Output Fields)** - HTTP 200

The service returns one result entry per submitted AWB number - an invalid/foreign/finalized number does NOT block the rest of the list.

| 
**Field** | 
**Description** | 

| 
success | 
Always true on HTTP 200 (per-number outcomes are inside "results" below). | 

| 
data.results | 
Array with one entry per submitted AWB number. | 

| 
results[].awbNumber | 
The AWB number, as submitted. | 

| 
results[].status | 
Outcome for this number - see table below. | 

| 
results[].message | 
Human-readable detail. Present for every status except "expedited". | 

| 
data.summary.total | 
Number of distinct AWB numbers processed (after dedup/trim). | 

| 
data.summary.expedited | 
How many were newly marked as Expedited. | 

| 
data.summary.skipped | 
How many were not changed (already expedited/final/not found/error). | 

**Per-number status values:**

| 
**status** | 
**Meaning** | 

| 
expedited | 
The shipment was marked as Expedited. | 

| 
already_expedited | 
It was already Expedited - nothing was overwritten (safe to resend). | 

| 
final_status | 
The shipment is already in a final status (e.g. Delivered, Returned, Cancelled) - the status was NOT changed. | 

| 
not_found | 
The number does not exist, or does not belong to the submitting client (foreign shipments are intentionally reported the same way as unknown ones, to avoid revealing that a number exists). | 

| 
error | 
Temporary technical issue - resubmit this number. | 

**Example:**

{
    "success": true,
    "data": {
        "results": [
            { "awbNumber": "17502058804253", "status": "expedited" },
            { "awbNumber": "458121566013", "status": "already_expedited", "message": "The shipment is already marked as expedited." },
            { "awbNumber": "3UW0K2X034483", "status": "final_status", "message": "The shipment is already in a final status (Delivered) and cannot be marked as expedited." },
            { "awbNumber": "UNKNOWN123", "status": "not_found", "message": "AWB not found." }
        ],
        "summary": { "total": 4, "expedited": 1, "skipped": 3 }
    }
}

`

**Notes:**

- Idempotent - resubmitting the same numbers does not create duplicate history entries.

- Can be called any number of times per day - with the full daily manifest at once, or in batches.

- The Expedited status is visible everywhere the current status is shown (reports, status history, get-status endpoints).

- The status only flows one way (client to us) - it is never pushed back to the client's own store/e-commerce platform as a notification.

**HTTP Errors:**

| 
**Code** | 
**Description** | 

| 
200 | 
Request accepted - see "results" for the per-number outcome, including invalid/foreign/finalized numbers. | 

| 
400 | 
{"error": "The awbNumbers list is required."} / {"error": "awbNumbers must be an array of AWB numbers."} / {"error": "Maximum 500 AWB numbers per request."} - malformed body. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
500 | 
{"success": false, "error": {"code": "STATUS_NOT_CONFIGURED", ...}} - the Expedited status is not yet configured in the system (see IN-4878). / Internal Server Error / This action is unauthorized. |

Request body:
```json
{
    "awbNumbers": [
        "17502058804253",
        "458121566013",
        "3UW0K2X034483"
    ]
}
```


## PreAWB



---
### Pre_AWB_Creation_Web_Service-v1.0

`POST https://api1.inout.bg/api/v1/preAWB`


Pre AWB Creation lets you register an order in the euShipments system **without** creating a courier waybill yet. No AWB/tracking number is generated at this step - the order is queued internally and a courier shipment is created for it later (in the euShipments back office or via a subsequent process). Use this when you want to reserve/queue an order before the courier waybill itself is needed.

**Precondition:** the Pre AWB service must be activated for your company in euShipments. If it isn't, every call fails with an "unauthorized" error - contact your euShipments account manager to have it enabled for your senderId.

Requirements

| 
**API Endpoint** | 
**Description** | 

| 
preAWB | 
Creates a pre-AWB order (no courier waybill yet) according to the provided API token and the order data. | 

Method: POST
Authorization: Bearer API_TOKEN

Example URLs

| 
**Environment** | 
**URL** | 

| 
Test | 
https://test-api.inout.bg/api/v1/preAWB | 

| 
Production | 
https://api1.inout.bg/api/v1/preAWB | 

API Call Input Fields
Body (JSON)

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
testMode | 
boolean | 
yes | 
 | 
If you want to use the API only for tests, set this field to true. Applies only to the production environment. On the test environment, all pre-AWBs save on test env. | 

| 
senderId (company id) | 
integer | 
yes | 
Must be an existing company ID, and Pre AWB must be activated for it. | 
ID of company, obtain an ID from Companies Web Service. | 

| 
courierId | 
integer | 
no | 
Must be an existing courier ID. | 
ID of the courier that will eventually handle the shipment, obtain an ID from Couriers Web Service. | 

| 
serviceName | 
string | 
no | 
Must be a service supported by the selected courier. | 
Service name, e.g. crossborder. | 

| 
waybillAvailableDate | 
date | 
yes | 
Must be between today and 9 days ahead (format YYYY-MM-DD). | 
The date on which the shipment is planned to be dispatched. | 

**recipient**

Addressing rules (all three apply independently - read carefully, they differ from the createAWB endpoint):

- recipient.countryIsoCode is **always required**, regardless of cityId.

- Send either recipient.cityId, **or both** recipient.cityName and recipient.zipCode together (sending only one of cityName/zipCode does not satisfy this rule).

- Independently of cityId/cityName, you must **always** send recipient.zipCode or recipient.region (at least one of the two, even when cityId is used).

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
name | 
string | 
yes | 
Max 100 characters. | 
Name of recipient or company. | 

| 
countryIsoCode | 
string | 
yes | 
Two-letter uppercase ISO code, e.g. BG, RO, HU. | 
Two-letter country ISO code of the delivery country. Always required for this endpoint. | 

| 
cityId | 
integer | 
conditional | 
Required unless both cityName and zipCode are sent. Must be an existing city ID. | 
The ID of the city where the shipment needs to be delivered. Obtain an ID from the Cities resource. | 

| 
cityName | 
string | 
conditional | 
See addressing rules above. Max 100 characters. | 
City name. | 

| 
zipCode | 
string | 
conditional | 
Required unless region is sent - see addressing rules above. Max 15 characters. | 
Zip code. | 

| 
region | 
string | 
conditional | 
Required unless zipCode is sent - see addressing rules above. Max 100 characters. | 
Region (county/municipality). | 

| 
officeId | 
integer | 
no | 
Must be an existing office ID. | 
Delivery to a courier office / PUDO / locker: the ID of the office, obtained from Courier_Offices_Web_Service_v1.2. | 

| 
officeCode | 
string | 
no | 
Must be an existing courier office code. | 
The courier's own office code (field COURIER_OFFICE_CODE in Courier_Offices_Web_Service_v1.2). Alternative to officeId. | 

| 
streetName | 
string | 
yes | 
Max 100 characters. **Always required, even when officeId or officeCode is sent** (unlike the createAWB endpoint, where it becomes optional in that case). | 
Name of the street - e.g. Main street or Main street 10. | 

| 
buildingNumber | 
integer | 
no | 
 | 
Number of the street/building - e.g. 10. | 

| 
addressText | 
string | 
no | 
Max 100 characters. | 
Additional address information - e.g. bl. 25, et. 3. | 

| 
contactPerson | 
string | 
no | 
Max 100 characters. | 
Contact person. Usually the same as the name of the recipient. | 

| 
phoneNumber | 
string | 
yes | 
Max 100 characters. | 
Phone number of the recipient. | 

| 
email | 
string | 
no | 
Must be a valid email format if sent (unlike createAWB, where the email field isn't validated at all). | 
Email of the recipient. | 

**awb**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
parcels | 
integer | 
yes | 
Min 0. | 
Number of parcels. | 

| 
envelopes | 
integer | 
yes | 
Min 0. | 
Number of envelopes. Usually 0. | 

| 
totalWeight | 
numeric | 
yes | 
**Min 0.5 kg.** | 
Total weight of the shipment in kg. Note the minimum is higher than on createAWB (0.01 kg there). | 

| 
declaredValue | 
numeric | 
no | 
Min 0. | 
Insurance amount of the shipment. | 

| 
bankRepayment | 
numeric | 
no | 
Min 0. | 
COD amount of the shipment in local currency. | 

| 
otherRepayment | 
string | 
no | 
Max 100 characters. | 
Additional information to COD. | 

| 
observations | 
string | 
no | 
Max 100 characters. | 
Additional information about the shipment/products (notes). | 

| 
openPackage | 
boolean | 
no | 
 | 
Check up the shipment before pay. | 

| 
saturdayDelivery | 
boolean | 
no | 
 | 
Saturday delivery. | 

| 
referenceNumber | 
string | 
yes | 
Max 100 characters. **Must be unique to avoid duplicate orders!** | 
Client reference number. | 

| 
products | 
string | 
no | 
Max 1000 characters. | 
The content of the shipment as free text, e.g. product1 product2. | 

| 
fragile | 
boolean | 
no | 
 | 
Marker whether the content is fragile. | 

| 
productsInfo | 
string | 
no | 
Max 2000 characters. **Note the exact key is `productsInfo` (capital I)** - a lowercase `productsinfo` is silently ignored by validation. | 
Additional product information. | 

| 
generateInoutLabelNum | 
boolean | 
no | 
 | 
When set to true, an INOUT label number is generated for the order - see Pre_AWB_Creation_INOUT_LABEL_Web_Service-v1.1. | 

**awb.packages**

Optional array.

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
dimensions.width | 
numeric | 
no | 
Min 0.1. | 
Width of the specific parcel in cm. | 

| 
dimensions.height | 
numeric | 
no | 
Min 0.1. | 
Height of the specific parcel in cm. | 

| 
dimensions.length | 
numeric | 
no | 
Min 0.1. | 
Length of the specific parcel in cm. | 

| 
weight | 
numeric | 
no | 
Min 0.001. | 
Weight of the specific parcel in kg. | 

**products** (top-level array)

Optional, and only lightly validated on this endpoint (only qty is checked - refNumber/price are not). For richer product data, prefer awb.products / awb.productsInfo above.

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
qty | 
integer | 
no | 
Min 1 (only enforced when the products array/item is sent). | 
Quantity of the product. | 

**Not supported on this endpoint:** unlike createAWB, Pre AWB does not accept/validate awb.document, sender, invoice, customsData, customs_declaration, courierRequest, returnLabel, courierReturnAWB or warehouseInfo. Sending them has no effect - configure those aspects on the real shipment once it is created from the order.

**API Response (Output Fields)**

On success the service returns HTTP 201 with:

| 
**Field** | 
**Description** | 

| 
orderId | 
Internal ID of the created order (no courier AWB exists yet). | 

| 
error | 
Always false on success. | 

| 
code | 
Always 201 on success. | 

| 
inoutLabelNum | 
Present only when awb.generateInoutLabelNum was sent as true - see Pre_AWB_Creation_INOUT_LABEL_Web_Service-v1.1. | 

**Example:**

{
    "orderId": 4815162,
    "error": false,
    "code": 201
}

`

On a business/processing error (e.g. the order could not be created for a reason surfaced after your input passed validation), the response has this shape, with the HTTP status equal to the code value:

{
    "orderId": null,
    "inoutLabelNum": null,
    "error": "error text",
    "code": 422
}

`

On a plain input-validation error (a required field missing, a value failing the rules in the tables above), the response is the simpler shape used across the API, with HTTP 400:

{
    "error": "error text"
}

`

HTTP Errors:

| 
Code | 
Description | 

| 
201 | 
Order created successfully. | 

| 
400 | 
Bad request / input validation failed - body is `{"error": "..."}`. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
404 | 
Not found data. | 

| 
422 | 
Unprocessable Entity - business error while creating the order (e.g. courier/config issue). Body follows the orderId/error/code shape above. | 

| 
500 | 
Internal Server Error, or Pre AWB not activated for this senderId ("This action is unauthorized."), or missing/invalid senderId. |

Request body:
```json
{
    "testMode": true,
    "senderId": 333,
    "courierId": 15,
    "waybillAvailableDate": "2023-06-29",
    "serviceName": "crossborder",
    "recipient": {
        "name": "API - TESTS",
        "countryIsoCode": "BG",
        "cityId": null,
        "cityName": "Sofia",
        "zipCode": "1000",
        "region": "",
        "officeId": null,
        "officeCode": null,
        "streetName": "ул. Цар Иван Асен II 64",
        "buildingNumber": 64,
        "addressText": null,
        "contactPerson": "API - TESTS",
        "phoneNumber": "0887000000",
        "email": "test@example.com"
    },
    "awb": {
        "referenceNumber": "bb-test-1000",
        "totalWeight": 1,
        "envelopes": 0,
        "parcels": 1,
        "declaredValue": null,
        "bankRepayment": null,
        "otherRepayment": "additional text for repayment",
        "openPackage": false,
        "saturdayDelivery": false,
        "productsInfo": "test product test product1",
        "fragile": 0,
        "observations": null,
        "products": "test",
        "packages": {
            "1": {
                "dimensions": {
                    "width": 10,
                    "height": 10,
                    "length": 10
                },
                "weight": 1
            }
        }
    }
}
```


---
### Pre_AWB_Creation_INOUT_LABEL_Web_Service-v1.1

`POST https://api1.inout.bg/api/v1/preAWB`


This is the **same endpoint and validation** as Pre_AWB_Creation_Web_Service-v1.0 (it creates an order in euShipments **without** a courier waybill yet). This page highlights the additional `awb.generateInoutLabelNum` flag: when sent as true, the order also gets an internal 17-digit INOUT label number that you can print immediately via Pre_AWB_INOUT_LABEL_Web_Service_v1.0 / Pre_AWB_INOUT_LABEL_BY_NUM_Web_Service_v1.0, before any courier waybill exists for the order.

**Precondition:** the Pre AWB service must be activated for your company in euShipments. If it isn't, every call fails with an "unauthorized" error - contact your euShipments account manager to have it enabled for your senderId.

Requirements

| 
**API Endpoint** | 
**Description** | 

| 
preAWB | 
Creates a pre-AWB order (no courier waybill yet) and, when requested, an INOUT label number for it. | 

Method: POST
Authorization: Bearer API_TOKEN

Example URLs

| 
**Environment** | 
**URL** | 

| 
Test | 
https://test-api.inout.bg/api/v1/preAWB | 

| 
Production | 
https://api1.inout.bg/api/v1/preAWB | 

API Call Input Fields
Body (JSON)

All fields are identical to Pre_AWB_Creation_Web_Service-v1.0 - see that page for the full field-by-field reference (testMode, senderId, courierId, serviceName, waybillAvailableDate, recipient., awb., awb.packages., products.). Only the extra flag is shown below.

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
awb.generateInoutLabelNum | 
boolean | 
yes (for this variant) | 
Set to true. | 
Requests generation of an internal INOUT label number for the order, returned as inoutLabelNum in the response. | 

**Reminder - addressing rules for recipient (same as the base endpoint):**

- recipient.countryIsoCode is always required, regardless of cityId.

- Send either recipient.cityId, or both recipient.cityName and recipient.zipCode together.

- Independently of cityId/cityName, always send recipient.zipCode or recipient.region (at least one of the two).

- recipient.streetName is always required, even when officeId or officeCode is sent.

**API Response (Output Fields)**

On success the service returns HTTP 201 with:

| 
**Field** | 
**Description** | 

| 
orderId | 
Internal ID of the created order (no courier AWB exists yet). | 

| 
error | 
Always false on success. | 

| 
code | 
Always 201 on success. | 

| 
inoutLabelNum | 
17-digit internal label number, format 33333330######### (33333330000000000 + internal record id). Use it with Pre_AWB_INOUT_LABEL_BY_NUM_Web_Service_v1.0 to print the label, or use orderId with Pre_AWB_INOUT_LABEL_Web_Service_v1.0. | 

**Example:**

{
    "orderId": 4815162,
    "error": false,
    "code": 201,
    "inoutLabelNum": "33333330004815162"
}

`

On a business/processing error, the response follows the orderId/error/code shape, with the HTTP status equal to the code value, and inoutLabelNum always present as null:

{
    "orderId": null,
    "inoutLabelNum": null,
    "error": "error text",
    "code": 422
}

`

On a plain input-validation error (a required field missing, a value failing the rules), the response is the simpler shape used across the API, with HTTP 400:

{
    "error": "error text"
}

`

HTTP Errors:

| 
Code | 
Description | 

| 
201 | 
Order (and INOUT label number) created successfully. | 

| 
400 | 
Bad request / input validation failed - body is `{"error": "..."}`. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
404 | 
Not found data. | 

| 
422 | 
Unprocessable Entity - business error while creating the order. Body follows the orderId/error/code shape above. | 

| 
500 | 
Internal Server Error, or Pre AWB not activated for this senderId ("This action is unauthorized."), or missing/invalid senderId. |

Request body:
```json
{
    "testMode": true,
    "senderId": 333,
    "courierId": 15,
    "waybillAvailableDate": "2023-06-29",
    "serviceName": "crossborder",
    "recipient": {
        "name": "API - TESTS",
        "countryIsoCode": "BG",
        "cityId": null,
        "cityName": "Sofia",
        "zipCode": "1000",
        "region": "",
        "officeId": null,
        "officeCode": null,
        "streetName": "ул. Цар Иван Асен II 64",
        "buildingNumber": 64,
        "addressText": null,
        "contactPerson": "API - TESTS",
        "phoneNumber": "0887000000",
        "email": "test@example.com"
    },
    "awb": {
        "referenceNumber": "bb-test-1000",
        "totalWeight": 1,
        "envelopes": 0,
        "parcels": 1,
        "declaredValue": null,
        "bankRepayment": null,
        "otherRepayment": "additional text for repayment",
        "openPackage": false,
        "saturdayDelivery": false,
        "productsInfo": "test product test product1",
        "fragile": 0,
        "observations": null,
        "products": "test",
        "generateInoutLabelNum": true,
        "packages": {
            "1": {
                "dimensions": {
                    "width": 10,
                    "height": 10,
                    "length": 10
                },
                "weight": 1
            }
        }
    }
}
```


---
### Pre_AWB_INOUT_LABEL_Web_Service_v1.0

`GET https://api1.inout.bg/api/v1/preAWB/print/inout/label/{OrderId}`


Prints (retrieves) the INOUT label for a pre-AWB order, identified by the order's internal **orderId** (the value returned by Pre_AWB_Creation_INOUT_LABEL_Web_Service-v1.1 in the `orderId` field, for an order that was created with `awb.generateInoutLabelNum: true`). No courier waybill needs to exist yet - this label is generated purely from the pre-AWB order data.

If you only have the 17-digit `inoutLabelNum` (not the internal orderId), use Pre_AWB_INOUT_LABEL_BY_NUM_Web_Service_v1.0 instead.

Requirements

| 
**API Endpoint** | 
**Description** | 

| 
preAWB/print/inout/label/{orderId} | 
Returns the INOUT label (PDF or ZPL) for the pre-AWB order with the given internal orderId. | 

Method: GET
Authorization: Bearer API_TOKEN

Example URLs

| 
**Environment** | 
**URL** | 

| 
Test | 
https://test-api.inout.bg/api/v1/preAWB/print/inout/label/{orderId}?testMode=0&printFileType=2 | 

| 
Production | 
https://api1.inout.bg/api/v1/preAWB/print/inout/label/{orderId}?testMode=0&printFileType=2 | 

API Call Input Fields
Path parameter

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
orderId | 
integer | 
yes | 
Must be an order that exists and has an INOUT label (created with awb.generateInoutLabelNum: true). | 
Internal order ID returned by Pre_AWB_Creation_INOUT_LABEL_Web_Service-v1.1. | 

Query string

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
testMode | 
boolean | 
**yes** | 
0 or 1. Not sending it fails validation. | 
Whether to look up the order on the test or production data set. | 

| 
printFileType | 
integer | 
no | 
Enum: 2 (PDF, default), 3 (ZPL). | 
Output format of the label. | 

**API Response (Output Fields)**

On success the service returns HTTP 200 with:

| 
**Field** | 
**Description** | 

| 
type | 
"PDF" or "ZPL", matching the requested printFileType. | 

| 
awb_print | 
The label content: base64-encoded PDF when type is "PDF", or the raw ZPL text when type is "ZPL". | 

**Example (PDF):**

{
    "type": "PDF",
    "awb_print": "JVBERi0xLjcKJcfsj6IKOCAwIG9iago8PC9MZW5ndGggOSAwIFIvRmlsdGVyIC9GbGF0ZURlY29kZT4+..."
}

`

**Example (ZPL):**

{
    "type": "ZPL",
    "awb_print": "^XA^FO50,50^A0N,40,40^FDTest label^FS^XZ"
}

`

On error:

{
    "error": "error text"
}

`

HTTP Errors:

| 
Code | 
Description | 

| 
200 | 
Returns result from the web service. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
422 | 
Unprocessable Entity - either the testMode query parameter is missing ("The field (testMode) required! Should present in your url query."), the specified orderId has no printable INOUT label ("Cannot print the specified orderId"), or ZPL generation failed ("Failed to generate ZPL label."). | 

| 
500 | 
Internal Server Error. |


---
### Pre_AWB_INOUT_LABEL_BY_NUM_Web_Service_v1.0

`GET https://api1.inout.bg/api/v1/preAWB/print/inout/label/num/{inoutLabelNum}`


Prints (retrieves) the INOUT label for a pre-AWB order, identified by the 17-digit **inoutLabelNum** itself (the value returned by Pre_AWB_Creation_INOUT_LABEL_Web_Service-v1.1 in the `inoutLabelNum` field, format 33333330#########, for an order that was created with `awb.generateInoutLabelNum: true`). No courier waybill needs to exist yet - this label is generated purely from the pre-AWB order data.

If you have the internal orderId instead of the label number, use Pre_AWB_INOUT_LABEL_Web_Service_v1.0 instead.

Requirements

| 
**API Endpoint** | 
**Description** | 

| 
preAWB/print/inout/label/num/{inoutLabelNum} | 
Returns the INOUT label (PDF or ZPL) for the pre-AWB order with the given 17-digit inoutLabelNum. | 

Method: GET
Authorization: Bearer API_TOKEN

Example URLs

| 
**Environment** | 
**URL** | 

| 
Test | 
https://test-api.inout.bg/api/v1/preAWB/print/inout/label/num/{inoutLabelNum}?testMode=0&printFileType=2 | 

| 
Production | 
https://api1.inout.bg/api/v1/preAWB/print/inout/label/num/{inoutLabelNum}?testMode=0&printFileType=2 | 

API Call Input Fields
Path parameter

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
inoutLabelNum | 
string | 
yes | 
17-digit number, format 33333330#########. Must belong to an order that exists and has an INOUT label. | 
The inoutLabelNum returned by Pre_AWB_Creation_INOUT_LABEL_Web_Service-v1.1. | 

Query string

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
testMode | 
boolean | 
**yes** | 
0 or 1. Not sending it fails validation. | 
Whether to look up the label on the test or production data set. | 

| 
printFileType | 
integer | 
no | 
Enum: 2 (PDF, default), 3 (ZPL). | 
Output format of the label. | 

**API Response (Output Fields)**

On success the service returns HTTP 200 with:

| 
**Field** | 
**Description** | 

| 
type | 
"PDF" or "ZPL", matching the requested printFileType. | 

| 
awb_print | 
The label content: base64-encoded PDF when type is "PDF", or the raw ZPL text when type is "ZPL". | 

**Example (PDF):**

{
    "type": "PDF",
    "awb_print": "JVBERi0xLjcKJcfsj6IKOCAwIG9iago8PC9MZW5ndGggOSAwIFIvRmlsdGVyIC9GbGF0ZURlY29kZT4+..."
}

`

**Example (ZPL):**

{
    "type": "ZPL",
    "awb_print": "^XA^FO50,50^A0N,40,40^FDTest label^FS^XZ"
}

`

On error:

{
    "error": "error text"
}

`

HTTP Errors:

| 
Code | 
Description | 

| 
200 | 
Returns result from the web service. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
422 | 
Unprocessable Entity - either the testMode query parameter is missing ("The field (testMode) required! Should present in your url query."), the specified inoutLabelNum has no printable label ("Cannot print the specified label number"), or ZPL generation failed ("Failed to generate ZPL label."). | 

| 
500 | 
Internal Server Error. |


## Others

### Shipment creation guidelines

##### **Phone format requirements:**

**Romania** (all carriers) - phone number without country phone prefix;
**Bulgaria** - phone number without country phone prefix;
**Greece** - phone number without country phone prefix;
**Poland** - phone number without country phone prefix;
**Czech Republic** - country phone prefix +420 or 00420 + valid mobile number (9 digits);
**Hungary** - country phone prefix +36 or 0036 + valid mobile number (9 digits);
**Slovakia** - country phone prefix +421 or 00421 + valid mobile number (9 digits);
**Croatia** - country phone prefix +385 or 00385 + valid mobile number (9 digits).

**Warning**: Send exactly ONE international prefix. Do not combine the national trunk prefix with the country code — for example, a Hungarian number sent as "0036" + "06..." (i.e. the national "06..." form concatenated after the country code) will be misread and may be rejected as a landline/invalid number. Strip the national prefix first: 06 30 123 4567 must be sent as 0036301234567 (or +36301234567).

#### **Delivery to a courier office / parcel locker (PUDO):**

1. Download the office nomenclature from https://api1.inout.bg/api/v1/offices-by-courier/{courierId} (see the Courier Offices Web Service).

2. Submit the shipment request in one of the following ways:

2.1 **Recommended**: in the "officeId" field, submit the "ID" value from our nomenclature. This is the most reliable option. Alternatively, you can submit the office code in the "officeCode" field.

2.2 In the "streetName" field, submit the keyword office + "OFFICE_NAME" from our nomenclature. **Important**: the word "office" must be at the very START of the streetName field (e.g. "office Aidemir").

2.3 In the "streetName" field, submit the keyword office + "ADDRESS" from our nomenclature. **Important**: the word "office" must be at the very START of the streetName field.

Sample data for the points described above:

2.1 (recommended — by officeId)

``` json
"recipient": {
    "name": "Test User",
    "countryIsoCode": "BG",
    "cityId": null,
    "region": null,
    "cityName": "Aidemir",
    "zipCode": "7538",
    "streetName": "",
    "buildingNumber": 0,
    "officeId": 1297,
    "officeCode": "",
    "addressText": "additional text, address test",
    "contactPerson": "Test User",
    "phoneNumber": "0889000000",
    "email": "test@example.com"
}

2.2 (by office name in streetName)

"recipient": {
    "name": "Test User",
    "countryIsoCode": "BG",
    "cityId": null,
    "region": null,
    "cityName": "Aidemir",
    "zipCode": "7538",
    "streetName": "office Aidemir",
    "buildingNumber": 0,
    "officeId": null,
    "officeCode": "",
    "addressText": "additional text, address test",
    "contactPerson": "Test User",
    "phoneNumber": "0889000000",
    "email": "test@example.com"
}

2.3 (by office address in streetName)

"recipient": {
    "name": "Test User",
    "countryIsoCode": "BG",
    "cityId": null,
    "region": null,
    "cityName": "Aidemir",
    "zipCode": "7538",
    "streetName": "office Aidemir kv. Delenkite ul. Sofia №7",
    "buildingNumber": 0,
    "officeId": null,
    "officeCode": "",
    "addressText": "additional text, address test",
    "contactPerson": "Test User",
    "phoneNumber": "0889000000",
    "email": "test@example.com"
}

Note: fields without a value should be sent as JSON null (e.g. "region": null), not as the string "null".

---
### Couriers_Web_Service_v1.0

`GET https://api1.inout.bg/api/v1/couriers/{companyId}`


We offer you the ability to ask for couriers directly from your company's software or website by taking advantage of the "Couriers Web Service".

**Requirements**

| 
**API Endpoint** | 
**Description** | 
**Restrictions** | 

| 
/couriers/{companyId} | 
With this service, you can receive the couriers activated for a chosen company. companyId is the ID of your company as returned by the Companies Web Service (/get-user-companies). | 
The companyId must be a company linked to your API token. A valid company ID that is not linked to your account returns HTTP 422. | 

**Method: GET**

**Authorization: Bearer API_TOKEN**

**Important**:

- If the response is an EMPTY ARRAY, the company has no couriers activated yet — please contact euShipments to add couriers to your client account.

- If you request a company ID that does not belong to your account (or does not exist), the service returns HTTP 422 with {"error":"You do not have access to couriers. Please contact an InOut employee."}.

**Examples:**

Test environment
https://test-api.inout.bg/api/v1/couriers/333

Production environment
https://api1.inout.bg/api/v1/couriers/333

**API Response (Output Fields)**

| 
**Field** | 
**Description** | 

| 
ID | 
ID of the courier. Use this value as courierId in the other web services. | 

| 
NAME | 
The courier name as used in the euShipments platform. It is composed as " " (e.g. "Hungary GLS New") — do not parse it as an official carrier name. | 

| 
TO_OFFICE | 
If this field is true, you can create shipments to an office with this courier. | 

| 
TO_ADDRESS | 
If this field is true, you can create shipments to an address with this courier. | 

| 
COUNTRY | 
Country where the carrier operates. | 

| 
CURRENCY | 
Local currency of the country. May be null. | 

Example:

[
 {
        "ID": 738,
        "NAME": "Hungary GLS New",
        "TO_OFFICE": false,
        "TO_ADDRESS": true,
        "COUNTRY": "Hungary",
        "CURRENCY": "HUF"
 }
]

`

**HTTP Errors:**

| 
**Code** | 
**Description** | 

| 
200 | 
Returns result from the web service. | 

| 
400 | 
Bad request. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
404 | 
Not found record. | 

| 
422 | 
Wrong params, or the company is not linked to your API token: {"error":"You do not have access to couriers. Please contact an InOut employee."}. | 

| 
500 | 
Internal Server Error / This action is unauthorized. |


---
### Companies_Web_Service_v1.0

`GET https://api1.inout.bg/api/v1/get-user-companies`


We offer you the ability to ask for the companies (client accounts) linked to your API token directly from your company's software or website by taking advantage of the "Companies Web Service".

The ID returned by this service is the companyId that you need for the Couriers Web Service (/couriers/{companyId}).

**Requirements**

| 
**API Endpoint** | 
**Description** | 

| 
/get-user-companies | 
With this service, you can receive the list of companies (client accounts) linked to your API token. | 

**Method: GET**

**Authorization: Bearer API_TOKEN**

**API Call Input Fields**

**URL query parameters**

| 
**field** | 
**type** | 
**required** | 
**description** | 

| 
testMode | 
boolean | 
no | 
If set to true, the data is read from the test environment database instead of the production one. | 

**Examples:**

Test environment
https://test-api.inout.bg/api/v1/get-user-companies

Production environment
https://api1.inout.bg/api/v1/get-user-companies

**API Response (Output Fields)**

The response is a JSON array — one element per company linked to your API token.

| 
**Field** | 
**Description** | 

| 
ID | 
ID of the company. Use this value as companyId in the Couriers Web Service. | 

| 
NAME | 
Company name. | 

| 
BULSTAT | 
Company registration / VAT number. | 

| 
ADDRESS | 
Company address. | 

| 
MOL | 
Company representative (materially liable person). | 

Example:

[
    {
        "ID": 333,
        "NAME": "Example Company Ltd.",
        "BULSTAT": "123456789",
        "ADDRESS": "Sofia, ul. Primerna 1",
        "MOL": "Ivan Ivanov"
    }
]

`

**HTTP Errors**

| 
**Code** | 
**Description** | 

| 
200 | 
Returns result from the web service. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
404 | 
Not found user — the API token is not recognized. | 

| 
422 | 
Not found companies for this user — no companies are linked to your account; please contact euShipments. | 

| 
500 | 
Internal Server Error / This action is unauthorized. |


---
### AWB_Details_Web_Service_v1.0

`GET https://api1.inout.bg/api/v1/get-awb/64506083?testMode=0`


We can now offer you the ability to ask for AWB details directly from your company's software or website by taking advantage of "AWB Details Web Service".

**Requirements**

| 
**API Endpoint** | 
**Description** | 

| 
get-awb/{AWBNumber} | 
Receive main data for an AWB by AWB number. | 

**Method: GET**
**Authorization: Bearer API_TOKEN**

**API Call Input Fields**
**URL query parameters**

| 
**field** | 
**type** | 
**required** | 
**restrictions** | 
**description** | 

| 
testMode | 
boolean | 
yes | 
 | 
If you want to use the API only for tests set this field to true. Applies only to the production environment. On the test environment, all shipments save on test env. | 

**Example URLs:**

Test: https://test-api.inout.bg/api/v1/get-awb/64506083?testMode=1
Production: https://api1.inout.bg/api/v1/get-awb/64506083?testMode=0

**API Response (Output Fields)**

| 
**Field** | 
**Description** | 

| 
ID | 
Internal ID of the shipment record in our system. | 

| 
SENDER_ID | 
ID of the company which created the shipment. | 

| 
REFERENCENUMBER | 
Your order reference number (the "referenceNumber" sent at AWB creation). | 

| 
WAYBILL_AVAILABLE_DATE | 
Date of AWB creation. | 

| 
RECIPIENT_NAME | 
Name of the recipient. | 

| 
CITYNAME | 
Name of the city where the recipient should receive the shipment. | 

| 
ZIPCODE | 
Zip code of the recipient city. | 

| 
STREET_NAME | 
Recipient street name (for office/locker deliveries contains the office destination text). | 

| 
BUILDING_NUMBER | 
Building number or street number. | 

| 
PHONE_NUMBER | 
Phone number of the recipient. | 

| 
PARCELS | 
Number of parcels. | 

| 
TOTAL_WEIGHT | 
Shipment weight. | 

| 
DECLARED_VALUE | 
Shipment insurance / insured amount. Differs per country. | 

| 
COD | 
COD amount. | 

| 
PAYEDNUMBER | 
The number of the payment protocol with which euShipments paid out the COD to you. Null until the COD has been paid out. | 

| 
PAYEDDATE | 
The date on which the COD payout to you was made. Null until the COD has been paid out. | 

| 
CURRENCY | 
Country currency. | 

| 
OPEN_PACKAGE | 
Check up shipment before pay ("open parcel" service). | 

| 
AWB_STATUS | 
The AWB status text at this moment. | 

| 
COMMENT | 
Comment to the shipment. | 

| 
PRICE | 
The shipment price charged for this AWB, converted to EUR. | 

| 
COURIER_PAYED_NUMBER | 
Reference number of the courier's own COD payment report in which the courier reported this COD as paid to euShipments. Null if the courier has not reported the payment yet. | 

| 
COURIER_PAYED_DATE | 
Date of the courier's own COD payment report. Null if the courier has not reported the payment yet. | 

| 
CNTR | 
Destination country of the shipment, ISO alpha-3 code. | 

| 
OP_WEIGHT_PRICE_BEFORE | 
Price by weight before any discount, converted to EUR. | 

| 
OP_DISC | 
Discount percent applied to the shipment. | 

| 
OP_DISC_PRICE | 
Discount amount, converted to EUR. | 

| 
OP_WEIGHT_PRICE | 
Price by weight after discount, converted to EUR. | 

| 
OP_SUM_PRICE | 
COD fee, converted to EUR. | 

| 
SMS_PRICE | 
SMS notification price, converted to EUR. | 

| 
OP_INS_PRICE | 
Insurance price, converted to EUR. | 

| 
FUEL_TAX_PRC | 
Fuel surcharge percent (not converted). | 

| 
FUEL_TAX_SUM | 
Fuel surcharge amount, converted to EUR. | 

| 
EXTRA_COST_SUM | 
Additional/extra costs, converted to EUR. | 

| 
SEND_TO_OFF | 
'A' = delivery to address, 'O' = delivery to a courier office. | 

| 
LAST_MILE_COUR_NAME | 
Name of the last-mile courier handling the shipment. | 

| 
INVOICED | 
true only when the outgoing invoice for this shipment has already been issued. | 

| 
INVOICE_NUMBER | 
Invoice number. Empty string when not yet invoiced. | 

| 
INVOICE_DATE | 
Invoice date (YYYY-MM-DD). Empty string when not yet invoiced. | 

**Example**:

{
    "ID": 12345678,
    "SENDER_ID": 1362,
    "REFERENCENUMBER": "185096-6608739-3",
    "WAYBILL_AVAILABLE_DATE": "2024-08-01 09:26:11",
    "RECIPIENT_NAME": "Faur Sergiu",
    "CITYNAME": "Ineu",
    "ZIPCODE": "315300",
    "STREET_NAME": "To office: easybox Republicii 3",
    "BUILDING_NUMBER": "0",
    "PHONE_NUMBER": "0743407779",
    "PARCELS": 1,
    "TOTAL_WEIGHT": "0.690",
    "DECLARED_VALUE": "0.00",
    "COD": "174.00",
    "PAYEDNUMBER": 1000001682,
    "PAYEDDATE": "2024-08-07 12:00:11",
    "CURRENCY": "RON",
    "OPEN_PACKAGE": 0,
    "AWB_STATUS": "New",
    "COMMENT": null,
    "PRICE": "6.00",
    "COURIER_PAYED_NUMBER": "451208",
    "COURIER_PAYED_DATE": "2024-08-05 00:00:00",
    "CNTR": "ROU",
    "OP_WEIGHT_PRICE_BEFORE": 6.00,
    "OP_DISC": 0,
    "OP_DISC_PRICE": 0,
    "OP_WEIGHT_PRICE": 6.00,
    "OP_SUM_PRICE": 0,
    "SMS_PRICE": 0,
    "OP_INS_PRICE": 0,
    "FUEL_TAX_PRC": null,
    "FUEL_TAX_SUM": 0,
    "EXTRA_COST_SUM": 0,
    "SEND_TO_OFF": "O",
    "LAST_MILE_COUR_NAME": "DPD",
    "INVOICED": true,
    "INVOICE_NUMBER": 2000020104,
    "INVOICE_DATE": "2026-06-30"
}

`

**HTTP Errors:**

| 
**Code** | 
**Description** | 

| 
200 | 
Returns result from the web service. | 

| 
400 | 
Bad request. | 

| 
401 | 
Unauthenticated. API expects a header like - 'Authorization: Bearer (api_token)'. | 

| 
422 | 
{"error": "Wrong awb number"} - the AWB number does not exist or is not accessible with your API token. Note: an unknown AWB returns 422, not 404. | 

| 
500 | 
Internal Server Error / This action is unauthorized. |

