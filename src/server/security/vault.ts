import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Credentials vault: AES-256-GCM with the key from env CREDENTIALS_KEY (32 bytes, base64).
 * The additional authenticated data (AAD) binds a ciphertext to its owner (e.g. the account), so a
 * ciphertext copied to another row/account does not decrypt.
 */

export const KEY_VERSION = 1;

export interface Sealed {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

function key(): Buffer {
  const raw = process.env.CREDENTIALS_KEY;
  if (!raw) throw new Error("CREDENTIALS_KEY is not set");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("CREDENTIALS_KEY must be 32 bytes, base64-encoded");
  return k;
}

export function seal(plaintext: string, aad: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ct.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion: KEY_VERSION,
  };
}

export function open(sealed: Sealed, aad: string): string {
  if (sealed.keyVersion !== KEY_VERSION) throw new Error(`Unknown key version ${sealed.keyVersion}`);
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(sealed.iv, "base64"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Compact single-string form for one-off secrets (e.g. a user's TOTP secret). */
export function sealToString(plaintext: string, aad: string): string {
  const s = seal(plaintext, aad);
  return ["v" + s.keyVersion, s.iv, s.authTag, s.ciphertext].join(".");
}

export function openFromString(value: string, aad: string): string {
  const [v, iv, authTag, ciphertext] = value.split(".");
  if (!v || !iv || !authTag || !ciphertext) throw new Error("Malformed sealed value");
  return open({ keyVersion: Number(v.slice(1)), iv, authTag, ciphertext }, aad);
}

/** Safe UI hint: never more than the last 4 characters, and nothing for short secrets. */
export function hintFor(secret: string): string {
  return secret.length >= 12 ? `••••${secret.slice(-4)}` : "••••";
}
