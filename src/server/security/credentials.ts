import type { AccountDb } from "@/server/db/client";
import { hintFor, open, seal } from "./vault";

/** What the UI/API may ever see about a stored credential. No ciphertext, no secret. */
export interface CredentialView {
  id: string;
  label: string;
  hint: string;
  updatedAt: Date;
}

const VIEW_SELECT = { id: true, label: true, hint: true, updatedAt: true } as const;

const aadFor = (accountId: string, credentialId: string) => `credential:${accountId}:${credentialId}`;

/**
 * Stores a secret (e.g. vendor JSON credentials serialised to a string). Write-only: returns only the view.
 * Pass `credentialId` to replace an existing secret (rotation).
 */
export async function saveCredential(
  db: AccountDb,
  accountId: string,
  input: { label: string; secret: string; userId?: string; credentialId?: string },
): Promise<CredentialView> {
  if (!input.secret) throw new Error("Secret must not be empty");
  const id = input.credentialId ?? crypto.randomUUID();
  const sealed = seal(input.secret, aadFor(accountId, id));
  const data = { label: input.label, hint: hintFor(input.secret), ...sealed };
  if (input.credentialId) {
    return db.credential.update({ where: { id }, data, select: VIEW_SELECT });
  }
  return db.credential.create({
    data: { id, accountId, createdById: input.userId ?? null, ...data },
    select: VIEW_SELECT,
  });
}

export async function listCredentials(db: AccountDb): Promise<CredentialView[]> {
  return db.credential.findMany({ select: VIEW_SELECT, orderBy: { label: "asc" } });
}

/** Server-only (adapters / worker). Never return the result to a browser or log it. */
export async function readCredentialSecret(db: AccountDb, accountId: string, credentialId: string) {
  const row = await db.credential.findUniqueOrThrow({ where: { id: credentialId } });
  return open(row, aadFor(accountId, row.id));
}
