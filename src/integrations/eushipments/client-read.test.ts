import { describe, expect, it, vi } from "vitest";
import { EuShipmentsClient } from "./client";
import { EuShipmentsError } from "./errors";
import RD from "./__fixtures__/read.json";

// Synthetic fixtures shaped like the vendor reference examples (no production data); fetch is mocked.
const TOKEN = "test-token-not-real-0001";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function fake(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const i = init ?? {};
    calls.push({ url, method: String(i.method), body: i.body ? JSON.parse(String(i.body)) : undefined });
    return handler(url, i);
  });
  return { calls, client: new EuShipmentsClient(TOKEN, { fetchImpl, sleep: async () => {} }) };
}

describe("EuShipmentsClient read side", () => {
  it("companies, couriers and warehouses", async () => {
    const f = fake((url) => {
      if (url.endsWith("/get-user-companies")) return json(RD.userCompanies);
      if (url.endsWith("/couriers/333")) return json(RD.couriers);
      if (url.endsWith("/fulfilment/warehouses")) return json(RD.warehouses);
      throw new Error(url);
    });
    expect((await f.client.getUserCompanies()).map((c) => Number(c.ID))).toEqual([333, 334]);
    const couriers = await f.client.getCouriers(333);
    expect(couriers[1]).toMatchObject({ ID: 15, TO_OFFICE: true, TO_ADDRESS: true, CURRENCY: null });
    expect(couriers[0]!.TO_OFFICE).toBe(false);
    const wh = await f.client.getWarehouses(333);
    expect(wh[0]).toMatchObject({ id: 1, name: "Warehouse Ruse", country: { iso: "BG" } });
    expect(f.calls[2]).toMatchObject({ method: "POST", body: { companyId: 333 } });
  });

  it("path ids must be positive integers", async () => {
    const f = fake(() => json([]));
    await expect(f.client.getCouriers(0)).rejects.toThrow(/positive integer/);
    await expect(f.client.getCities(Number.NaN, 10, 0)).rejects.toThrow(/positive integer/);
    expect(f.calls).toHaveLength(0);
  });

  it("countries: the documented 404 (no couriers activated) is an empty list, not an error", async () => {
    const f = fake(() => json({ error: "You do not have access to countries!" }, 404));
    expect(await f.client.getCountries()).toEqual([]);
  });

  it("cities are paged with paging=1, first, skip", async () => {
    const f = fake(() => json(RD.cities));
    const rows = await f.client.getCities(2, 1000, 2000);
    expect(rows).toHaveLength(2);
    const u = new URL(f.calls[0]!.url);
    expect(u.pathname).toBe("/api/v1/get-cities/2");
    expect(Object.fromEntries(u.searchParams)).toEqual({ paging: "1", first: "1000", skip: "2000" });
  });

  it("offices: paginated mode; 404 = no offices", async () => {
    const f = fake((url) => {
      if (url.includes("/offices-by-courier/15")) return json(RD.officesPage1);
      return json({ error: "Office not found" }, 404);
    });
    const page = await f.client.getOfficesPage(15, 1, 1000);
    expect(page.pagination.last_page).toBe(2);
    expect(page.offices[0]).toMatchObject({ ID: 1297, IS_STATION: false, COD_SUPPORT: true });
    expect(new URL(f.calls[0]!.url).searchParams.get("per_page")).toBe("1000");
    expect((await f.client.getOfficesPage(99, 1, 1000)).offices).toEqual([]);
  });

  it("product availability takes no parameters", async () => {
    const f = fake(() => json(RD.prodAvails));
    const rows = await f.client.getProdAvails();
    expect(rows[0]).toMatchObject({ REFERENCE_NUMBER: "ref-test-54202", AVAIL_QTY: 87 });
    expect(f.calls[0]!.url).toBe("https://api1.inout.bg/api/v1/fulfilment/get-prod-avails");
  });

  it("booking status and request status", async () => {
    const f = fake((url) =>
      url.includes("get-request-status/137") ? json(RD.requestStatusAccepted) : json(RD.bookingStatusClosed),
    );
    expect(await f.client.getRequestStatus(137)).toMatchObject({ accepted: true });
    const b = await f.client.bookingRequestStatus(333, 137);
    expect(b.products[1]).toMatchObject({ booked: 100, accepted: 98, comment: "2 damaged items" });
    expect(f.calls[1]).toMatchObject({ method: "POST", body: { companyId: 333, bookingId: 137 } });
  });

  it("COD by reference: explicit testMode, null body = nothing found", async () => {
    const f = fake((url) => {
      if (url.includes("TST-1001")) return json(RD.codPaid);
      if (url.includes("EMPTY")) return new Response("", { status: 200 });
      return new Response("null", { status: 200 });
    });
    expect(await f.client.checkCodByOrder("TST-1001")).toMatchObject({ payedNumber: 10793 });
    expect(new URL(f.calls[0]!.url).searchParams.get("testMode")).toBe("0");
    expect(await f.client.checkCodByOrder("NONE-1")).toBeNull();
    expect(await f.client.checkCodByOrder("EMPTY-1")).toBeNull();
  });

  it("reads retry 5xx, then fail; 401 is an auth error; unreadable answers are invalid_response", async () => {
    let n = 0;
    const f = fake(() => (++n < 3 ? json({}, 503) : json(RD.countries)));
    expect(await f.client.getCountries()).toHaveLength(2);
    expect(n).toBe(3);
    const g = fake(() => json({ message: "Unauthenticated." }, 401));
    await expect(g.client.getProdAvails()).rejects.toMatchObject({ code: "auth_failed" });
    const h = fake(() => json({ unexpected: true }));
    const err = await h.client.getProdAvails().catch((e) => e);
    expect(err).toBeInstanceOf(EuShipmentsError);
    expect(err.code).toBe("invalid_response");
  });
});
