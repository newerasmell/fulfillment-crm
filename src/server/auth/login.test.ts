import { generate } from "otplib";
import { beforeAll, describe, expect, it } from "vitest";
import { systemDb } from "@/server/db/client";
import { verifyLogin } from "./login";
import { MAX_FAILURES_PER_EMAIL_IP } from "./rate-limit";
import { verifyTotp } from "./totp";
import { bootstrapOwner, createUser, revokeSessions } from "./users";

const PASSWORD = "correct horse battery staple";

describe("TOTP", () => {
  it("rejects malformed codes and replays", async () => {
    const created = await createUser({
      email: `totp-${Date.now()}@example.com`,
      name: "T",
      password: PASSWORD,
    });
    const code = await generate({ secret: created.totpSecret });
    const step = await verifyTotp(created.totpSecret, code);
    expect(step).toBeTypeOf("number");
    expect(await verifyTotp(created.totpSecret, code, step)).toBeNull(); // same step again
    expect(await verifyTotp(created.totpSecret, "12345")).toBeNull();
    expect(await verifyTotp(created.totpSecret, "abcdef")).toBeNull();
  });
});

describe("verifyLogin", () => {
  const email = `owner-${Date.now()}@example.com`;
  let secret: string;
  let userId: string;

  beforeAll(async () => {
    const r = await bootstrapOwner({ email, name: "Owner", accountName: "Test Co", password: PASSWORD });
    secret = r.totpSecret;
    userId = r.user.id;
    expect(r.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
  });

  const login = (over: Partial<{ email: string; password: string; code: string; ip: string }> = {}) =>
    verifyLogin({ email, password: PASSWORD, code: "", ip: "10.0.0.1", userAgent: "vitest", ...over });

  it("requires the second factor", async () => {
    expect(await login()).toEqual({ ok: false, reason: "totp_required" });
  });

  it("logs in with password + TOTP, case-insensitive email, and records the step", async () => {
    const code = await generate({ secret });
    const r = await login({ email: email.toUpperCase(), code });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.user).toMatchObject({ id: userId, email, sessionVersion: 0 });
    // the same code cannot be used twice
    expect(await login({ code })).toEqual({ ok: false, reason: "invalid" });
    const membership = await systemDb().membership.findFirst({ where: { userId } });
    expect(membership?.role).toBe("OWNER");
  });

  it("gives the same generic error for wrong password, wrong code and unknown user", async () => {
    const code = await generate({ secret });
    expect(await login({ password: "wrong password here", code, ip: "10.0.0.2" })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await login({ code: "000000", ip: "10.0.0.2" })).toEqual({ ok: false, reason: "invalid" });
    expect(await login({ email: "nobody@example.com", code, ip: "10.0.0.2" })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("disabled users cannot log in", async () => {
    const other = await createUser({
      email: `disabled-${Date.now()}@example.com`,
      name: "D",
      password: PASSWORD,
    });
    await systemDb().user.update({ where: { id: other.user.id }, data: { disabled: true } });
    const code = await generate({ secret: other.totpSecret });
    expect(
      await verifyLogin({ email: other.user.email, password: PASSWORD, code, ip: null, userAgent: null }),
    ).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rate-limits repeated failures from the same place, without locking the user out elsewhere", async () => {
    const victim = await createUser({ email: `rl-${Date.now()}@example.com`, name: "R", password: PASSWORD });
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL_IP; i++) {
      await verifyLogin({
        email: victim.user.email,
        password: "bad password!!",
        code: "123456",
        ip: "10.9.9.9",
        userAgent: null,
      });
    }
    const code = await generate({ secret: victim.totpSecret });
    expect(
      await verifyLogin({
        email: victim.user.email,
        password: PASSWORD,
        code,
        ip: "10.9.9.9",
        userAgent: null,
      }),
    ).toEqual({ ok: false, reason: "rate_limited" });
    // the real user, somewhere else, can still sign in
    expect(
      await verifyLogin({
        email: victim.user.email,
        password: PASSWORD,
        code,
        ip: "10.1.1.1",
        userAgent: null,
      }),
    ).toMatchObject({ ok: true });
  });

  it("one source hammering an account cannot lock its owner out from elsewhere", async () => {
    const victim = await createUser({
      email: `lock-${Date.now()}@example.com`,
      name: "L",
      password: PASSWORD,
    });
    for (let i = 0; i < 40; i++) {
      await verifyLogin({
        email: victim.user.email,
        password: "attacker guess!!",
        code: "123456",
        ip: "10.6.6.6",
        userAgent: null,
      });
    }
    const code = await generate({ secret: victim.totpSecret });
    expect(
      await verifyLogin({
        email: victim.user.email,
        password: PASSWORD,
        code,
        ip: "10.2.2.2",
        userAgent: null,
      }),
    ).toMatchObject({ ok: true });
  });

  it("parallel guesses are all counted (attempt recorded before the check)", async () => {
    const victim = await createUser({
      email: `burst-${Date.now()}@example.com`,
      name: "B",
      password: PASSWORD,
    });
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        verifyLogin({
          email: victim.user.email,
          password: "guess guess guess",
          code: "123456",
          ip: "10.7.7.7",
          userAgent: null,
        }),
      ),
    );
    expect(results.filter((r) => !r.ok && r.reason === "rate_limited").length).toBeGreaterThanOrEqual(
      12 - MAX_FAILURES_PER_EMAIL_IP,
    );
  });

  it("revokeSessions bumps the session version", async () => {
    await revokeSessions(userId);
    const u = await systemDb().user.findUniqueOrThrow({ where: { id: userId } });
    expect(u.sessionVersion).toBe(1);
  });

  it("never stores the TOTP secret or password in clear", async () => {
    const u = await systemDb().user.findUniqueOrThrow({ where: { id: userId } });
    expect(u.totpSecretEnc).not.toContain(secret);
    expect(u.passwordHash).toMatch(/^\$argon2id\$/);
  });
});
