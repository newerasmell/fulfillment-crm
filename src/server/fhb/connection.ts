import { z } from "zod";
import {
  FhbClient,
  FhbCredentials,
  parseFhbCredentials,
  type FhbClientOptions,
} from "@/integrations/fhb-v3/client";
import { DomainError, type Actor } from "@/server/accounts";
import { recordAudit } from "@/server/audit";
import { assertCan } from "@/server/auth/rbac";
import type { CompanyScope } from "@/server/companies";
import { accountDb, systemDb } from "@/server/db/client";
import { readCredentialSecret, saveCredential } from "@/server/security/credentials";

/**
 * FHB v3 connections: one FulfillmentConnection (type FHB_V3) per FHB credential set, credentials sealed in the
 * vault as JSON {appId, secret} and never returned. New connections start in READ_ONLY (CLAUDE.md); raising
 * the mode is the outbox's setConnectionMode (OWNER only, audited).
 */

export type ScopedActor = Actor & { companyScope?: CompanyScope };

/** Restricted members act only on connections of their companies (permission, not a DB wall). */
export function assertConnectionInScope(actor: ScopedActor, companyId: string | null) {
  if (actor.companyScope && !actor.companyScope.includes(companyId ?? "")) throw new DomainError("not_found");
}

export const FhbConnectionInput = z.object({
  companyId: z.string().min(1).max(64),
  name: z.string().trim().min(2).max(100),
  appId: FhbCredentials.shape.appId,
  secret: FhbCredentials.shape.secret,
  /** Prefix FHB product ids carry on top of the CRM SKU (configured per connection, never hard-coded). */
  skuPrefix: z
    .string()
    .trim()
    .max(20)
    .regex(/^[^#&%\s]*$/)
    .optional(),
});

/** The vault hint for FHB: the app id's tail (never derived from the JSON blob, which ends in the secret). */
export function fhbCredentialHint(appId: string) {
  return appId.length >= 8 ? `app ••••${appId.slice(-4)}` : "••••";
}

export async function createFhbConnection(actor: Actor, raw: z.input<typeof FhbConnectionInput>) {
  assertCan(actor.role, "connections.manage");
  assertCan(actor.role, "credentials.write");
  const input = FhbConnectionInput.parse(raw);
  const db = accountDb(actor.accountId);
  const company = await db.company.findUnique({ where: { id: input.companyId } });
  if (!company || company.archivedAt) throw new DomainError("not_found");
  const cred = await saveCredential(db, actor.accountId, {
    label: `FHB · ${input.name}`,
    secret: JSON.stringify({ appId: input.appId, secret: input.secret }),
    hint: fhbCredentialHint(input.appId),
    userId: actor.userId,
  });
  const connection = await db.fulfillmentConnection.create({
    data: {
      accountId: actor.accountId,
      companyId: input.companyId,
      type: "FHB_V3",
      name: input.name,
      liveMode: "READ_ONLY",
      credentialId: cred.id,
      skuPrefixRule: input.skuPrefix ? { prefix: input.skuPrefix } : {},
    },
    select: { id: true, name: true, liveMode: true, companyId: true },
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "fhb.connection.create",
    entityType: "FulfillmentConnection",
    entityId: connection.id,
    after: { name: input.name, companyId: input.companyId, skuPrefix: input.skuPrefix ?? null },
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
  return connection;
}

/** Credential rotation in place (same Credential row); the cached client picks it up via updatedAt. */
export async function rotateFhbCredentials(
  actor: Actor,
  connectionId: string,
  raw: { appId: string; secret: string },
) {
  assertCan(actor.role, "credentials.write");
  const creds = FhbCredentials.parse(raw);
  const db = accountDb(actor.accountId);
  const c = await db.fulfillmentConnection.findUnique({ where: { id: connectionId } });
  if (!c || c.type !== "FHB_V3") throw new DomainError("not_found");
  if (!c.credentialId) throw new DomainError("no_credentials");
  await saveCredential(db, actor.accountId, {
    label: `FHB · ${c.name}`,
    secret: JSON.stringify(creds),
    hint: fhbCredentialHint(creds.appId),
    credentialId: c.credentialId,
  });
  await recordAudit({
    accountId: actor.accountId,
    userId: actor.userId,
    action: "fhb.connection.rotate_credentials",
    entityType: "FulfillmentConnection",
    entityId: connectionId,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
}

/** Clients per connection, rebuilt when the credential changes (rotation). Server-only, never logged. */
const clientCache = new Map<string, { version: number; client: FhbClient }>();

/** Server-only: a ready client for one FHB connection (credentials read from the vault). */
export async function fhbClientForConnection(
  accountId: string,
  connectionId: string,
  opts: FhbClientOptions = {},
): Promise<FhbClient> {
  const db = accountDb(accountId);
  const c = await db.fulfillmentConnection.findUnique({
    where: { id: connectionId },
    select: { type: true, credentialId: true, credential: { select: { updatedAt: true } } },
  });
  if (!c || c.type !== "FHB_V3") throw new DomainError("not_found");
  if (!c.credentialId || !c.credential) throw new DomainError("no_credentials");
  const custom = Object.keys(opts).length > 0;
  const version = c.credential.updatedAt.getTime();
  const hit = clientCache.get(connectionId);
  if (!custom && hit && hit.version === version) return hit.client;
  const client = new FhbClient(
    parseFhbCredentials(await readCredentialSecret(db, accountId, c.credentialId)),
    opts,
  );
  if (!custom) clientCache.set(connectionId, { version, client });
  return client;
}

/** The account a connection belongs to (worker side, where only the connection id is known). */
export async function connectionAccount(connectionId: string) {
  return systemDb().fulfillmentConnection.findUnique({
    where: { id: connectionId },
    select: { id: true, accountId: true, type: true, companyId: true },
  });
}
