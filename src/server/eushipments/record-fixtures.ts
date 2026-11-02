import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EuShipmentsClientOptions } from "@/integrations/eushipments/client";
import {
  SCRUBBER_VERSION,
  scrubResponse,
  type Endpoint,
  type RecordedFixture,
} from "@/integrations/eushipments/fixtures/scrub";
import { accountDb } from "@/server/db/client";
import { euClientFor } from "./connection";

/**
 * `fixtures:record` for euShipments (GATE P3-G1, run by the owner, never in CI): runs the READ side once
 * against a configured connection, scrubs every response (fixtures/scrub.ts) and writes
 * src/integrations/eushipments/__fixtures__/recorded/<endpoint>.json. Only GET/list calls (plus the read-only
 * POSTs warehouses / orders-history / booking-request-status). Lists are cut to a few rows. A response with a
 * field the scrubber does not know is NOT written — classify the field first.
 */

export const RECORDED_DIR = "src/integrations/eushipments/__fixtures__/recorded";
const KEEP = 10;
const cut = (v: unknown) => (Array.isArray(v) ? v.slice(0, KEEP) : v);

export async function recordEuFixtures(
  accountId: string,
  connectionId: string,
  opts: { outDir?: string; clientOptions?: EuShipmentsClientOptions; now?: Date } = {},
) {
  const { client, companyId } = await euClientFor(accountId, connectionId, opts.clientOptions);
  const db = accountDb(accountId);
  const calls: [Endpoint, () => Promise<unknown>][] = [
    ["get-user-companies", () => client.getUserCompanies()],
    ["couriers", () => client.getCouriers(companyId)],
    ["warehouses", async () => ({ data: await client.getWarehouses(companyId) })],
    ["get-countries", () => client.getCountries()],
    ["get-products", () => client.getProducts(companyId)],
    ["get-prod-avails", () => client.getProdAvails()],
  ];
  const country = await db.eushipmentsCountry.findFirst({
    where: { connectionId },
    orderBy: { countryId: "asc" },
  });
  if (country) calls.push(["get-cities", () => client.getCities(country.countryId, KEEP, 0)]);
  const courier = await db.eushipmentsCourier.findFirst({ where: { connectionId, toOffice: true } });
  if (courier) calls.push(["offices-by-courier", () => client.getOfficesPage(courier.courierId, 1, 50)]);
  const shipments = await db.fulfillment.findMany({
    where: { connectionId, status: { notIn: ["QUEUED", "SUBMITTING", "SUBMIT_FAILED"] } },
    select: { externalId: true, status: true },
    orderBy: { createdAt: "desc" },
    take: KEEP,
  });
  if (shipments.length)
    calls.push(["orders-history", () => client.ordersHistory(shipments.map((s) => s.externalId))]);
  const delivered = shipments.find((s) => s.status === "DELIVERED" || s.status === "COD_PAID");
  if (delivered)
    calls.push(["check-cod-by-order", () => client.checkCodByOrder(delivered.externalId, false)]);
  const booking = await db.inboundShipment.findFirst({
    where: { connectionId, vendorId: { not: null } },
    orderBy: { createdAt: "desc" },
  });
  if (booking?.vendorId) {
    calls.push(["get-request-status", () => client.getRequestStatus(Number(booking.vendorId))]);
    calls.push([
      "booking-request-status",
      () => client.bookingRequestStatus(companyId, Number(booking.vendorId)),
    ]);
  }

  const outDir = opts.outDir ?? RECORDED_DIR;
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  const refused: { endpoint: Endpoint; unclassified: string[] }[] = [];
  const failed: { endpoint: Endpoint; error: string }[] = [];
  for (const [endpoint, call] of calls) {
    let response: unknown;
    try {
      response = cut(await call());
    } catch (err) {
      failed.push({ endpoint, error: (err as Error).message });
      continue;
    }
    const s = scrubResponse(endpoint, response);
    if (s.unclassified.length) {
      refused.push({ endpoint, unclassified: s.unclassified });
      continue;
    }
    const file: RecordedFixture = {
      endpoint,
      scrubberVersion: SCRUBBER_VERSION,
      recordedAt: (opts.now ?? new Date()).toISOString().slice(0, 10),
      response: s.data,
    };
    const target = path.join(outDir, `${endpoint}.json`);
    writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`);
    written.push(target);
  }
  return { written, refused, failed };
}
