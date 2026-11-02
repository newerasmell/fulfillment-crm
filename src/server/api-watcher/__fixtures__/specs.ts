/**
 * Synthetic vendor specs for the API watcher tests, shaped like docs/integrations/raw/* (OpenAPI 3 for FHB,
 * a published Postman collection for euShipments). Invented endpoints/values — no real business data.
 */

export function syntheticOpenApi(opts: { changed?: boolean } = {}): Record<string, unknown> {
  const c = !!opts.changed;
  const changelog = [
    "Synthetic API.",
    "",
    "### Change log",
    "",
    ...(c ? ["#### 2026-11-01", "", "- Removed `GET /stock`.", ""] : []),
    "#### 2026-07-01",
    "",
    "- Added `GET /stock`.",
  ].join("\n");
  const paths: Record<string, unknown> = {
    "/order": {
      get: {
        summary: "Order detail",
        parameters: [{ name: "id", in: "query", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } },
          },
          "404": { description: "Not found" },
        },
      },
      post: {
        summary: "Create order",
        requestBody: {
          content: { "application/json": { schema: { $ref: "#/components/schemas/NewOrder" } } },
        },
        responses: { "200": { description: "Created" } },
      },
    },
  };
  if (!c) {
    paths["/stock"] = {
      get: {
        summary: "Stock",
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { product: { type: "string" }, quantity: { type: "integer" } },
                  },
                },
              },
            },
          },
        },
      },
    };
  } else {
    paths["/rma/list"] = {
      get: { summary: "Returned shipments", responses: { "200": { description: "OK" } } },
    };
  }
  return {
    openapi: "3.0.0",
    info: { title: "Synthetic warehouse API", version: "3.0", description: changelog },
    servers: [{ url: "https://api.example.test/v3" }],
    paths,
    components: {
      schemas: {
        NewOrder: {
          type: "object",
          required: c ? ["id", "items", "note"] : ["id", "items"],
          properties: {
            id: { type: "string", maxLength: c ? 15 : 20 },
            carrier: { type: "string", enum: c ? ["gls", "dpd", "packeta"] : ["gls", "dpd"] },
            items: {
              type: "array",
              items: {
                type: "object",
                required: ["product"],
                properties: { product: { type: "string" }, quantity: { type: "integer" } },
              },
            },
            ...(c ? { note: { type: "string" }, cod_currency: { type: "string" } } : {}),
          },
        },
        Order: {
          type: "object",
          properties: {
            id: { type: "string" },
            status: {
              type: "string",
              enum: c ? ["pending", "confirmed", "sent", "returned"] : ["pending", "confirmed", "sent"],
            },
            ...(c ? { weight: { type: "number" } } : { tracking: { type: "string" } }),
          },
        },
      },
    },
  };
}

const table = (header: string[], rows: string[][]) =>
  `<div class="click-to-expand-wrapper is-table-wrapper"><table>\n<thead>\n<tr>\n${header
    .map((h) => `<th><strong>${h}</strong></th>`)
    .join("\n")}\n</tr>\n</thead>\n<tbody>\n${rows
    .map((r) => `<tr>\n${r.map((c) => `<td>${c}</td>`).join("\n")}\n</tr>`)
    .join("\n")}\n</tbody>\n</table>\n</div>`;
const heading = (h: string) => `<p><strong>${h}</strong></p>\n`;

export function syntheticPostman(opts: { extraField?: boolean } = {}): Record<string, unknown> {
  const recipientRows = [["phone", "string", "yes", "max 20 characters", "Recipient phone"]];
  if (opts.extraField) recipientRows.push(["email", "string", "no", "", "Recipient e-mail"]);
  const inputHeader = ["field", "type", "required", "restrictions", "description"];
  const createDescription = [
    "<p>Creates a shipment.</p>",
    heading("API Call Input Fields"),
    table(inputHeader, [["testMode", "boolean", "yes", "", "Test flag"]]),
    heading("recipient"),
    table(inputHeader, recipientRows),
    heading("API Response (Output Fields)"),
    table(["Field", "Description"], [["awb", "Waybill number"]]),
    heading("Changelog"),
    table(["Version", "Change"], [["1.5", "Added recipient.phone rules"]]),
  ].join("\n");
  return {
    info: {
      _postman_id: "00000000-0000-0000-0000-000000000001",
      name: "Synthetic shipping API",
      description: "<p>Synthetic.</p>",
      publishDate: "2026-11-01T00:00:00Z",
    },
    item: [
      {
        name: "AWB Creation",
        id: "folder-1",
        item: [
          {
            name: "Shipment_Creation_Web_Service_v1.5",
            id: "req-1",
            request: {
              method: "POST",
              header: [],
              url: "https://api.example.test/api/v1/createAWB",
              urlObject: {
                protocol: "https",
                path: ["api", "v1", "createAWB"],
                host: ["api", "example", "test"],
                query: [],
              },
              body: {
                mode: "raw",
                raw: '{\n    "testMode": 0, //Test flag, see https://example.test/docs\n    "recipient": {\n        "phone": "+359000000000"\n    }\n}',
              },
              description: createDescription,
            },
            response: [],
          },
        ],
      },
      {
        name: "Shipment_Status_Web_Service_v1.1",
        id: "req-2",
        request: {
          method: "GET",
          header: [],
          url: "https://api.example.test/api/v1/get-status/{AWBNumber}?testMode=0",
          description:
            heading("Statuses") +
            table(
              ["ID", "Status", "Final Status"],
              [
                ["1", "New", "no"],
                ["2", "Delivered", "yes"],
              ],
            ),
        },
        response: [],
      },
    ],
  };
}
