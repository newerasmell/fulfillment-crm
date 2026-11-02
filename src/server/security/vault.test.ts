import { Writable } from "node:stream";
import { beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "@/lib/logger";
import { accountDb, systemDb } from "@/server/db/client";
import { listCredentials, readCredentialSecret, saveCredential } from "./credentials";
import { hintFor, open, openFromString, seal, sealToString } from "./vault";

const SECRET = "fhb-app-secret-0123456789abcdef";

describe("vault", () => {
  it("round-trips and binds to the AAD", () => {
    const s = seal(SECRET, "credential:A:1");
    expect(s.ciphertext).not.toContain(SECRET);
    expect(open(s, "credential:A:1")).toBe(SECRET);
    expect(() => open(s, "credential:B:1")).toThrow();
    expect(() =>
      open({ ...s, ciphertext: Buffer.from("tampered").toString("base64") }, "credential:A:1"),
    ).toThrow();
  });

  it("uses a fresh IV every time", () => {
    expect(seal(SECRET, "x").iv).not.toBe(seal(SECRET, "x").iv);
  });

  it("compact string form round-trips", () => {
    const v = sealToString("JBSWY3DPEHPK3PXPJBSWY3DP", "totp:u1");
    expect(openFromString(v, "totp:u1")).toBe("JBSWY3DPEHPK3PXPJBSWY3DP");
    expect(() => openFromString(v, "totp:u2")).toThrow();
  });

  it("hints never reveal more than 4 characters", () => {
    expect(hintFor(SECRET)).toBe("••••cdef");
    expect(hintFor("short")).toBe("••••");
  });

  it("refuses to run without a valid key", () => {
    const saved = process.env.CREDENTIALS_KEY;
    process.env.CREDENTIALS_KEY = Buffer.alloc(16).toString("base64");
    try {
      expect(() => seal("x", "y")).toThrow(/32 bytes/);
    } finally {
      process.env.CREDENTIALS_KEY = saved;
    }
  });
});

describe("credentials service", () => {
  let accountId: string;
  beforeAll(async () => {
    accountId = (await systemDb().account.create({ data: { name: "Vault test" } })).id;
  });

  it("never returns the secret or ciphertext, but the server can read it back", async () => {
    const db = accountDb(accountId);
    const view = await saveCredential(db, accountId, { label: "FHB", secret: SECRET });
    const listed = await listCredentials(db);
    for (const payload of [view, listed]) {
      const json = JSON.stringify(payload);
      expect(json).not.toContain(SECRET);
      expect(json).not.toMatch(/ciphertext|authTag|"iv"/);
    }
    expect(Object.keys(view).sort()).toEqual(["hint", "id", "label", "updatedAt"]);
    expect(await readCredentialSecret(db, accountId, view.id)).toBe(SECRET);

    const rotated = await saveCredential(db, accountId, {
      label: "FHB",
      secret: "new-secret-value-9999",
      credentialId: view.id,
    });
    expect(rotated.hint).toBe("••••9999");
    expect(await readCredentialSecret(db, accountId, view.id)).toBe("new-secret-value-9999");
  });

  it("logger redacts secrets", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = createLogger({ level: "info" }, sink);
    log.info(
      { secret: SECRET, credentials: { app_secret: SECRET }, headers: { authorization: `Bearer ${SECRET}` } },
      "x",
    );
    log.info({ req: { password: SECRET, token: SECRET } }, "y");
    expect(lines.join("")).not.toContain(SECRET);
    expect(lines.join("")).toContain("[REDACTED]");
  });
});
