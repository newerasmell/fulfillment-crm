import { generateSecret, generateURI, verify } from "otplib";

export const TOTP_ISSUER = "Fulfillment CRM";

export function newTotpSecret() {
  return generateSecret();
}

export function totpUri(secret: string, email: string) {
  return generateURI({ issuer: TOTP_ISSUER, label: email, secret });
}

/**
 * Verifies a 6-digit code with ±1 step tolerance. Returns the matched time step, or null.
 * `afterStep` rejects codes from the last accepted step or earlier (replay protection).
 */
export async function verifyTotp(
  secret: string,
  code: string,
  afterStep?: number | null,
): Promise<number | null> {
  const token = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(token)) return null;
  const result = await verify({
    secret,
    token,
    epochTolerance: 30,
    ...(afterStep != null ? { afterTimeStep: afterStep } : {}),
  });
  // epoch = start (seconds) of the matched 30-second period, so epoch / 30 is the RFC 6238 time step.
  if (!result.valid || !("epoch" in result)) return null;
  return Math.floor(result.epoch / 30);
}
