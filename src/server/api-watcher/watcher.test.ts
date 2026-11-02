import { beforeAll, describe, expect, it, vi } from "vitest";
import { bootstrapOwner } from "@/server/auth/users";
import { accountDb, systemDb } from "@/server/db/client";
import { saveCredential } from "@/server/security/credentials";
import { syntheticOpenApi, syntheticPostman } from "./__fixtures__/specs";
import { ALERT_KINDS, demoteVendorConnections, raiseAlertEverywhere } from "./safety";
import { runShopifyVersionWatch } from "./shopify-version";
import { SPEC_SOURCES, type SpecSource } from "./sources";
import {
  FAILURE_ALERT_AFTER,
  readCommittedSpec,
  runSpecWatch as runSpecWatchReal,
  type StoredDiff,
} from "./watcher";

// P9-01 with a mocked fetch: the build environment never fetches a real spec.

// Real safety functions, wrapped so one test can make a step fail once (crash between storing and acting).
vi.mock("./safety", async (importOriginal) => {
  const m = await importOriginal<typeof import("./safety")>();
  return {
    ...m,
    demoteVendorConnections: vi.fn(m.demoteVendorConnections),
    raiseAlertEverywhere: vi.fn(m.raiseAlertEverywhere),
  };
});

// The committed raw copy is replaced by the synthetic spec: first runs then match it (a plain baseline).
const syntheticCommitted = async (s: SpecSource) =>
  s.format === "openapi" ? syntheticOpenApi() : syntheticPostman();
const runSpecWatch = (o: Parameters<typeof runSpecWatchReal>[0] = {}) =>
  runSpecWatchReal({ baseline: syntheticCommitted, ...o });

const FHB = SPEC_SOURCES.find((s) => s.vendor === "FHB_V3")!;
const EU = SPEC_SOURCES.find((s) => s.vendor === "EUSHIPMENTS")!;

function fakeFetch(bodies: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    if (!(url in bodies)) throw new Error(`unexpected fetch ${url}`);
    const b = bodies[url];
    if (b instanceof Response) return b;
    return new Response(JSON.stringify(b), { status: 200 });
  });
}

describe("spec watcher (DB)", () => {
  let accountA: string;
  let accountB: string;
  let liveConn: string;
  let readOnlyConn: string;
  let joyConn: string;

  beforeAll(async () => {
    await systemDb().apiSpecVersion.deleteMany({});
    await systemDb().apiWatchSource.deleteMany({});
    const mk = async (n: string) =>
      (
        await bootstrapOwner({
          email: `watch-${n}-${Date.now()}@example.com`,
          name: "O",
          accountName: `Watcher group ${n}`,
          password: "correct horse battery staple",
        })
      ).account.id;
    accountA = await mk("a");
    accountB = await mk("b");
    const cred = await saveCredential(accountDb(accountA), accountA, {
      label: "fhb",
      secret: '{"k":"synthetic"}',
    });
    const conn = (type: "FHB_V3" | "FHB_JOY", liveMode: "LIVE" | "READ_ONLY") =>
      accountDb(accountA).fulfillmentConnection.create({
        data: { accountId: accountA, type, name: `${type} ${liveMode}`, liveMode, credentialId: cred.id },
      });
    liveConn = (await conn("FHB_V3", "LIVE")).id;
    readOnlyConn = (await conn("FHB_V3", "READ_ONLY")).id;
    joyConn = (await conn("FHB_JOY", "LIVE")).id;
  });

  const alerts = (accountId: string, kind: string) =>
    accountDb(accountId).alert.findMany({ where: { kind } });

  it("first run records a baseline without alerting; same spec again is unchanged", async () => {
    const fetchImpl = fakeFetch({ [FHB.url]: syntheticOpenApi(), [EU.url]: syntheticPostman() });
    const sources = [FHB, EU];
    const first = await runSpecWatch({ fetchImpl, sources });
    expect(first.map((o) => o.outcome)).toEqual(["baseline", "baseline"]);
    const again = await runSpecWatch({ fetchImpl, sources });
    expect(again.map((o) => o.outcome)).toEqual(["unchanged", "unchanged"]);
    expect(await systemDb().apiSpecVersion.count()).toBe(2);
    expect(await alerts(accountA, ALERT_KINDS.specChange)).toHaveLength(0);
    const src = await systemDb().apiWatchSource.findUniqueOrThrow({ where: { id: "FHB_V3" } });
    expect(src.failures).toBe(0);
    expect(src.lastOkAt).not.toBeNull();
  });

  it("a breaking change stores history + diff + brief, alerts every account and drops that vendor's LIVE connections", async () => {
    const fetchImpl = fakeFetch({ [FHB.url]: syntheticOpenApi({ changed: true }) });
    const [out] = await runSpecWatch({ fetchImpl, sources: [FHB] });
    expect(out).toMatchObject({ vendor: "FHB_V3", outcome: "changed" });
    // Other test files may own LIVE FHB connections too (shared test DB): at least ours.
    expect((out as { demoted: number }).demoted).toBeGreaterThanOrEqual(1);

    const versions = await systemDb().apiSpecVersion.findMany({
      where: { vendor: "FHB_V3" },
      orderBy: { fetchedAt: "asc" },
    });
    expect(versions).toHaveLength(2);
    const diff = versions[1]!.diff as unknown as StoredDiff;
    expect(diff.previousId).toBe(versions[0]!.id);
    expect(diff.counts.breaking).toBeGreaterThan(0);
    expect(diff.brief).toContain("# Upgrade brief: FHB Kika API v3");

    for (const acc of [accountA, accountB]) {
      const [a] = await alerts(acc, ALERT_KINDS.specChange);
      expect(a).toMatchObject({
        severity: "CRITICAL",
        entityType: "ApiSpecVersion",
        entityId: versions[1]!.id,
      });
      expect(a!.body).toContain("Upgrade brief");
    }
    const modes = await systemDb().fulfillmentConnection.findMany({
      where: { id: { in: [liveConn, readOnlyConn, joyConn] } },
      select: { id: true, liveMode: true },
    });
    const mode = (id: string) => modes.find((m) => m.id === id)!.liveMode;
    expect(mode(liveConn)).toBe("DRY_RUN");
    expect(mode(readOnlyConn)).toBe("READ_ONLY"); // never raised
    expect(mode(joyConn)).toBe("LIVE"); // another vendor
    const audit = await accountDb(accountA).auditLog.findFirst({
      where: { action: "connection.mode_change", entityId: liveConn },
    });
    expect(audit?.before).toEqual({ liveMode: "LIVE" });
    expect(audit?.after).toMatchObject({ liveMode: "DRY_RUN" });
    expect(audit?.userId).toBeNull();

    // Re-running with the same new spec does nothing more.
    const [again] = await runSpecWatch({ fetchImpl, sources: [FHB] });
    expect(again!.outcome).toBe("unchanged");
    expect(await alerts(accountA, ALERT_KINDS.specChange)).toHaveLength(1);
  });

  it("an additive-only change is a WARNING and changes no mode", async () => {
    await accountDb(accountA).fulfillmentConnection.update({
      where: { id: liveConn },
      data: { liveMode: "LIVE" },
    });
    const fetchImpl = fakeFetch({ [EU.url]: syntheticPostman({ extraField: true }) });
    const [out] = await runSpecWatch({ fetchImpl, sources: [EU] });
    expect(out).toMatchObject({ outcome: "changed", demoted: 0 });
    if (out?.outcome !== "changed") throw new Error("expected change");
    expect(out.diff.counts.breaking).toBe(0);
    expect(out.diff.counts.additive).toBe(1);
    const [a] = await alerts(accountA, ALERT_KINDS.specChange).then((r) =>
      r.filter((x) => x.entityId === out.versionId),
    );
    expect(a?.severity).toBe("WARNING");
    const c = await systemDb().fulfillmentConnection.findUniqueOrThrow({ where: { id: liveConn } });
    expect(c.liveMode).toBe("LIVE");
  });

  it("fetch failures are counted and alerted once after the threshold; an odd response is a failure, not a change", async () => {
    const joy: SpecSource = SPEC_SOURCES.find((s) => s.vendor === "FHB_JOY")!;
    const down = fakeFetch({ [joy.url]: new Response("bad gateway", { status: 502 }) });
    for (let i = 0; i < FAILURE_ALERT_AFTER + 1; i++) {
      const [o] = await runSpecWatch({
        fetchImpl: vi.fn(async () => (await down(joy.url)).clone()),
        sources: [joy],
      });
      expect(o).toMatchObject({ outcome: "failed", error: "HTTP 502" });
    }
    const src = await systemDb().apiWatchSource.findUniqueOrThrow({ where: { id: "FHB_JOY" } });
    expect(src.failures).toBe(FAILURE_ALERT_AFTER + 1);
    expect(await alerts(accountA, ALERT_KINDS.specFetchFailed)).toHaveLength(1);

    const [odd] = await runSpecWatch({
      fetchImpl: fakeFetch({ [joy.url]: { hello: "world" } }),
      sources: [joy],
    });
    expect(odd).toMatchObject({ outcome: "failed", error: "unexpected_shape" });
    expect(await systemDb().apiSpecVersion.count({ where: { vendor: "FHB_JOY" } })).toBe(0);

    const [ok] = await runSpecWatch({
      fetchImpl: fakeFetch({ [joy.url]: syntheticOpenApi() }),
      sources: [joy],
    });
    expect(ok!.outcome).toBe("baseline");
    expect((await systemDb().apiWatchSource.findUniqueOrThrow({ where: { id: "FHB_JOY" } })).failures).toBe(
      0,
    );
  });

  it("a failure after the version is stored is finished by the next run (demotion + alerts)", async () => {
    // FHB is at the "changed" spec now: go back to the original first, then change again.
    const back = await runSpecWatch({
      fetchImpl: fakeFetch({ [FHB.url]: syntheticOpenApi() }),
      sources: [FHB],
    });
    expect(back[0]!.outcome).toBe("changed");
    await accountDb(accountA).fulfillmentConnection.update({
      where: { id: liveConn },
      data: { liveMode: "LIVE" },
    });

    const fetchImpl = fakeFetch({ [FHB.url]: syntheticOpenApi({ changed: true }) });
    vi.mocked(demoteVendorConnections).mockRejectedValueOnce(new Error("lock timeout"));
    const [failed] = await runSpecWatch({ fetchImpl, sources: [FHB] });
    expect(failed).toMatchObject({ outcome: "failed", error: "internal" });
    const stored = await systemDb().apiSpecVersion.findFirstOrThrow({
      where: { vendor: "FHB_V3" },
      orderBy: [{ fetchedAt: "desc" }, { id: "desc" }],
    });
    expect((stored.diff as unknown as StoredDiff).applied).toBe(false);
    expect(
      (await systemDb().fulfillmentConnection.findUniqueOrThrow({ where: { id: liveConn } })).liveMode,
    ).toBe("LIVE");

    // Retry with the same spec: the hash is unchanged, but the unfinished side effects are completed.
    vi.mocked(raiseAlertEverywhere).mockRejectedValueOnce(new Error("db blip"));
    expect((await runSpecWatch({ fetchImpl, sources: [FHB] }))[0]!.outcome).toBe("failed");
    expect(
      (await systemDb().fulfillmentConnection.findUniqueOrThrow({ where: { id: liveConn } })).liveMode,
    ).toBe("DRY_RUN"); // demoted before the alert step failed
    const [again] = await runSpecWatch({ fetchImpl, sources: [FHB] });
    expect(again).toMatchObject({ outcome: "unchanged", versionId: stored.id });
    const after = await systemDb().apiSpecVersion.findUniqueOrThrow({ where: { id: stored.id } });
    expect((after.diff as unknown as StoredDiff).applied).toBe(true);
    for (const acc of [accountA, accountB]) {
      const list = (await alerts(acc, ALERT_KINDS.specChange)).filter((a) => a.entityId === stored.id);
      expect(list).toHaveLength(1);
      expect(list[0]!.severity).toBe("CRITICAL");
    }
  });

  it("first run diffs the live spec against the committed raw copy, not just takes it as baseline", async () => {
    const seeded: SpecSource = {
      ...EU,
      vendor: "SEED_TEST" as SpecSource["vendor"],
      url: "https://x.test/seed",
    };
    await systemDb().apiSpecVersion.deleteMany({ where: { vendor: seeded.vendor } });
    const [out] = await runSpecWatch({
      fetchImpl: fakeFetch({ [seeded.url]: syntheticPostman({ extraField: true }) }),
      sources: [seeded],
      baseline: async () => syntheticPostman(),
    });
    expect(out).toMatchObject({ outcome: "changed" });
    if (out?.outcome !== "changed") throw new Error("expected change");
    expect(out.diff.counts.additive).toBe(1);
    const versions = await systemDb().apiSpecVersion.findMany({
      where: { vendor: seeded.vendor },
      orderBy: [{ fetchedAt: "asc" }, { id: "asc" }],
    });
    expect(versions.map((v) => v.sourceUrl)).toEqual([`repo:${EU.rawFile}`, seeded.url]);
    expect(versions[0]!.diff).toBeNull();
    const [a] = (await alerts(accountA, ALERT_KINDS.specChange)).filter((x) => x.entityId === out.versionId);
    expect(a?.severity).toBe("WARNING");

    // Committed copy unreadable: the first live fetch is the baseline (old behaviour).
    const fallback: SpecSource = { ...seeded, vendor: "SEED_TEST2" as SpecSource["vendor"] };
    await systemDb().apiSpecVersion.deleteMany({ where: { vendor: fallback.vendor } });
    const [b] = await runSpecWatch({
      fetchImpl: fakeFetch({ [seeded.url]: syntheticPostman() }),
      sources: [fallback],
      baseline: async () => null,
    });
    expect(b!.outcome).toBe("baseline");
  });

  it("the committed raw copies of every source load and pass the envelope check", async () => {
    for (const s of SPEC_SOURCES) expect(await readCommittedSpec(s), s.vendor).not.toBeNull();
    expect(await readCommittedSpec({ ...EU, rawFile: "docs/integrations/raw/missing.json" })).toBeNull();
  });

  it("Shopify version watch alerts admins as the pinned version's support ends", async () => {
    expect((await runShopifyVersionWatch(new Date("2026-11-02T00:00:00Z"))).level).toBe("ok");
    expect(await alerts(accountA, ALERT_KINDS.shopifyVersion)).toHaveLength(0);
    expect((await runShopifyVersionWatch(new Date("2027-08-01T00:00:00Z"))).level).toBe("warning");
    expect((await runShopifyVersionWatch(new Date("2027-08-02T00:00:00Z"))).level).toBe("warning");
    const list = await alerts(accountB, ALERT_KINDS.shopifyVersion);
    expect(list).toHaveLength(1); // deduplicated while open
    expect(list[0]!.severity).toBe("WARNING");

    // 30 days before the end: the open WARNING is escalated to CRITICAL, not swallowed.
    expect((await runShopifyVersionWatch(new Date("2027-09-15T00:00:00Z"))).level).toBe("critical");
    const escalated = await alerts(accountB, ALERT_KINDS.shopifyVersion);
    expect(escalated).toHaveLength(1);
    expect(escalated[0]).toMatchObject({ severity: "CRITICAL", status: "OPEN" });
    // A later WARNING never lowers it.
    await runShopifyVersionWatch(new Date("2027-08-03T00:00:00Z"));
    expect((await alerts(accountB, ALERT_KINDS.shopifyVersion))[0]!.severity).toBe("CRITICAL");
  });
});
