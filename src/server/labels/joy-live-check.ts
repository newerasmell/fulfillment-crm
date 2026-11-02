import { z } from "zod";
import { JOY_STATUSES, JoyDeliveryPoints, JoyShipmentInfo } from "@/integrations/fhb-joy/schemas";
import {
  checkEnum,
  registerLiveCheck,
  validateProbe,
  type LiveCheck,
  type LiveCheckIssue,
} from "@/server/api-watcher/live-check";
import { accountDb } from "@/server/db/client";
import { joyClientFor, joySettingsOf } from "./connection";

/**
 * Daily read-only live check for FHB Joy connections (P9-02 hook, CLAUDE.md "each adapter gets a read-only live
 * check"): login, GET /delivery-point for the first configured parcel service, and GET /shipment for the newest
 * label the CRM holds. Only GET calls — never a label.
 */
export const joyLiveCheck: LiveCheck = {
  type: "FHB_JOY",
  async run(target, ctx) {
    const client = await joyClientFor(
      target.accountId,
      target.id,
      ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl, sleep: ctx.sleep } : {},
    );
    const db = accountDb(target.accountId);
    const conn = await db.fulfillmentConnection.findUniqueOrThrow({
      where: { id: target.id },
      select: { vendorIds: true },
    });
    const issues: LiveCheckIssue[] = [];
    const probes: string[] = ["POST /login"];
    await client.testLogin();
    const service = joySettingsOf(conn.vendorIds).parcelServices[0];
    if (service) {
      probes.push("GET /delivery-point");
      const raw = await client.request("GET", "/delivery-point", {
        query: { parcelService: service },
        schema: z.unknown(),
      });
      issues.push(...validateProbe("GET /delivery-point", JoyDeliveryPoints, raw).issues);
    }
    const latest = await db.fulfillment.findFirst({
      where: { connectionId: target.id, status: { notIn: ["QUEUED", "SUBMIT_FAILED"] } },
      orderBy: { createdAt: "desc" },
      select: { externalId: true },
    });
    if (latest) {
      probes.push("GET /shipment");
      const raw = await client
        .request("GET", "/shipment", { query: { id: latest.externalId }, schema: z.unknown() })
        .catch((e: { code?: string }) => (e?.code === "not_found" ? null : Promise.reject(e)));
      if (raw !== null) {
        const v = validateProbe("GET /shipment", JoyShipmentInfo, raw);
        issues.push(...v.issues);
        const st = checkEnum("GET /shipment", "status", v.data?.status ?? null, new Set(JOY_STATUSES));
        if (st) issues.push(st);
      }
    }
    return { probes, issues };
  },
};

let registered = false;
export function registerJoyLiveCheck() {
  if (registered) return;
  registerLiveCheck(joyLiveCheck);
  registered = true;
}
