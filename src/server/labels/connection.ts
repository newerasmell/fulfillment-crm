import { z } from "zod";
import {
  JoyClient,
  JoyCredentials,
  parseJoyCredentials,
  type JoyClientOptions,
} from "@/integrations/fhb-joy/client";
import { EuAwbClient } from "@/integrations/eushipments/awb-client";
import type { EuShipmentsClientOptions } from "@/integrations/eushipments/client";
import { DomainError, type Actor } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import { accountDb } from "@/server/db/client";
import { loadEuConnection } from "@/server/eushipments/connection";
import { fhbCredentialHint } from "@/server/fhb/connection";
import { readCredentialSecret, saveCredential } from "@/server/security/credentials";
import type { ScopedActor } from "@/server/stores";

/**
 * FHB Joy connections (labels for parcels we pack): one FulfillmentConnection of type FHB_JOY per Joy credential
 * set ({appId, secret} sealed in the vault, never returned). New connections start in READ_ONLY (CLAUDE.md);
 * raising the mode is the outbox's setConnectionMode (OWNER only, audited). Joy has no endpoint that lists the
 * parcel services enabled for an account, so the OWNER/ADMIN enters their codes (ZOE → API) on the connection;
 * they are stored in vendorIds with the optional sender code / name.
 */

const ServiceCode = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[A-Za-z0-9_.-]+$/);

export const JoySettings = z.object({
  parcelServices: z.array(ServiceCode).max(40).default([]),
  /** Parcel services that deliver only to pick-up points (a delivery point is then required). */
  pickupServices: z.array(ServiceCode).max(40).default([]),
  /** One of the account's configured sender codes (reference: contact support to use several). */
  sender: z.string().trim().max(60).optional().nullable(),
  senderName: z.string().trim().max(100).optional().nullable(),
});
export type JoySettings = z.infer<typeof JoySettings>;

/** vendorIds of an FHB_JOY connection: the settings + the last connection test. */
export const JoyVendorIds = JoySettings.extend({
  lastTest: z
    .object({ ok: z.boolean(), at: z.string(), error: z.string().nullable().optional() })
    .optional()
    .nullable(),
});

export function joySettingsOf(vendorIds: unknown) {
  const p = JoyVendorIds.safeParse(vendorIds ?? {});
  return p.success ? p.data : JoyVendorIds.parse({});
}

export const JoyConnectionInput = z.object({
  companyId: z.string().min(1).max(64),
  name: z.string().trim().min(2).max(100),
  appId: JoyCredentials.shape.appId,
  secret: JoyCredentials.shape.secret,
  settings: JoySettings.default({ parcelServices: [], pickupServices: [] }),
});

function assertCompany(actor: ScopedActor, companyId: string | null) {
  if (actor.companyScope && !actor.companyScope.includes(companyId ?? "")) throw new DomainError("not_found");
}

export async function createJoyConnection(actor: ScopedActor, raw: z.input<typeof JoyConnectionInput>) {
  assertCan(actor.role, "connections.manage");
  assertCan(actor.role, "credentials.write");
  const input = JoyConnectionInput.parse(raw);
  assertCompany(actor, input.companyId);
  const db = accountDb(actor.accountId);
  const company = await db.company.findUnique({ where: { id: input.companyId } });
  if (!company || company.archivedAt) throw new DomainError("not_found");
  const cred = await saveCredential(db, actor.accountId, {
    label: `FHB Joy · ${input.name}`,
    secret: JSON.stringify({ appId: input.appId, secret: input.secret }),
    hint: fhbCredentialHint(input.appId),
    userId: actor.userId,
  });
  const connection = await db.fulfillmentConnection.create({
    data: {
      accountId: actor.accountId,
      companyId: input.companyId,
      type: "FHB_JOY",
      name: input.name,
      liveMode: "READ_ONLY",
      credentialId: cred.id,
      vendorIds: input.settings,
    },
    select: { id: true, name: true, liveMode: true, companyId: true },
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "joy.connection.create",
    entityType: "FulfillmentConnection",
    entityId: connection.id,
    after: { name: input.name, companyId: input.companyId, settings: input.settings },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return connection;
}

async function loadJoy(actor: ScopedActor, connectionId: string) {
  const c = await accountDb(actor.accountId).fulfillmentConnection.findUnique({
    where: { id: connectionId },
  });
  if (!c || c.type !== "FHB_JOY") throw new DomainError("not_found");
  assertCompany(actor, c.companyId);
  return c;
}

export async function updateJoySettings(
  actor: ScopedActor,
  connectionId: string,
  raw: z.input<typeof JoySettings>,
) {
  assertCan(actor.role, "connections.manage");
  const settings = JoySettings.parse(raw);
  const c = await loadJoy(actor, connectionId);
  const before = joySettingsOf(c.vendorIds);
  await accountDb(actor.accountId).fulfillmentConnection.update({
    where: { id: connectionId },
    data: { vendorIds: { ...before, ...settings } },
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "joy.connection.settings",
    entityType: "FulfillmentConnection",
    entityId: connectionId,
    before: {
      parcelServices: before.parcelServices,
      pickupServices: before.pickupServices,
      sender: before.sender ?? null,
    },
    after: settings,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}

export async function rotateJoyCredentials(
  actor: ScopedActor,
  connectionId: string,
  raw: { appId: string; secret: string },
) {
  assertCan(actor.role, "credentials.write");
  const creds = JoyCredentials.parse(raw);
  const c = await loadJoy(actor, connectionId);
  if (!c.credentialId) throw new DomainError("no_credentials");
  await saveCredential(accountDb(actor.accountId), actor.accountId, {
    label: `FHB Joy · ${c.name}`,
    secret: JSON.stringify(creds),
    hint: fhbCredentialHint(creds.appId),
    credentialId: c.credentialId,
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "joy.connection.rotate_credentials",
    entityType: "FulfillmentConnection",
    entityId: connectionId,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}

/** Clients per connection, rebuilt when the credential changes (rotation). Server-only, never logged. */
const joyCache = new Map<string, { version: number; client: JoyClient }>();

/** Server-only (worker): a ready Joy client for one connection. */
export async function joyClientFor(accountId: string, connectionId: string, opts: JoyClientOptions = {}) {
  const db = accountDb(accountId);
  const c = await db.fulfillmentConnection.findUnique({
    where: { id: connectionId },
    select: { type: true, credentialId: true, credential: { select: { updatedAt: true } } },
  });
  if (!c || c.type !== "FHB_JOY") throw new DomainError("not_found");
  if (!c.credentialId || !c.credential) throw new DomainError("no_credentials");
  const custom = Object.keys(opts).length > 0;
  const version = c.credential.updatedAt.getTime();
  const hit = joyCache.get(connectionId);
  if (!custom && hit && hit.version === version) return hit.client;
  const client = new JoyClient(
    parseJoyCredentials(await readCredentialSecret(db, accountId, c.credentialId)),
    opts,
  );
  if (!custom) joyCache.set(connectionId, { version, client });
  return client;
}

/** Server-only (worker): the euShipments AWB client of a connection (same Bearer token as the fulfilment client). */
export async function awbClientFor(
  accountId: string,
  connectionId: string,
  opts: EuShipmentsClientOptions = {},
) {
  const { connection, companyId } = await loadEuConnection(accountId, connectionId);
  if (!connection.credentialId) throw new DomainError("no_credentials");
  if (!companyId) throw new DomainError("no_company_id");
  const token = (await readCredentialSecret(accountDb(accountId), accountId, connection.credentialId)).trim();
  return { connection, companyId, client: new EuAwbClient(token, opts) };
}

/** Connection test result for a Joy connection (login only — a read). */
export async function recordJoyTest(
  accountId: string,
  connectionId: string,
  r: { ok: boolean; error?: string | null },
) {
  const db = accountDb(accountId);
  const c = await db.fulfillmentConnection.findUnique({
    where: { id: connectionId },
    select: { vendorIds: true },
  });
  if (!c) return;
  await db.fulfillmentConnection.update({
    where: { id: connectionId },
    data: {
      vendorIds: {
        ...joySettingsOf(c.vendorIds),
        lastTest: { ok: r.ok, at: new Date().toISOString(), error: r.error ?? null },
      },
    },
  });
}

export type { Actor };
