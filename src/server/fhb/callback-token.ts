import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { FHB_NOTIFICATION_EVENTS, type FhbNotificationEvent } from "@/integrations/fhb-v3/schemas";

/**
 * Secret-path tokens for FHB callbacks (INTEGRATION_NOTES §2.2/§2.3, SPEC §9). FHB documents no signature for its
 * notifications, so the secret lives in the URL: an HMAC over (connection, what the URL is for), keyed with a
 * key derived from CREDENTIALS_KEY (HKDF, separate purpose label — the vault key itself is never used directly).
 * Order URLs carry the shipment id, because FHB's order-notification body format is not documented: the
 * callback only says "re-read this order" and the worker does GET /order?id= (never trusts the body).
 * Rotating CREDENTIALS_KEY invalidates the URLs already stored at FHB (orders and products): re-send them.
 */

const TOKEN_LENGTH = 32;

function callbackKey(): Buffer {
  const raw = process.env.CREDENTIALS_KEY;
  if (!raw) throw new Error("CREDENTIALS_KEY is not set");
  const ikm = Buffer.from(raw, "base64");
  if (ikm.length !== 32) throw new Error("CREDENTIALS_KEY must be 32 bytes, base64-encoded");
  return Buffer.from(hkdfSync("sha256", ikm, "fhb-callback-v1", "fhb callback url token", 32));
}

export type FhbCallbackScope =
  { kind: "stock" } | { kind: "order"; fulfillmentId: string; event: FhbNotificationEvent };

const scopeString = (s: FhbCallbackScope) =>
  s.kind === "stock" ? "stock" : `order:${s.fulfillmentId}:${s.event}`;

export function fhbCallbackToken(connectionId: string, scope: FhbCallbackScope): string {
  return createHmac("sha256", callbackKey())
    .update(`${connectionId}|${scopeString(scope)}`)
    .digest("base64url")
    .slice(0, TOKEN_LENGTH);
}

export function verifyFhbCallbackToken(
  connectionId: string,
  scope: FhbCallbackScope,
  token: string,
): boolean {
  if (typeof token !== "string" || token.length !== TOKEN_LENGTH) return false;
  const want = Buffer.from(fhbCallbackToken(connectionId, scope));
  const got = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Public https base of the web service (same rule as the Shopify webhook registration). */
export function publicBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.APP_URL || (env.APP_HOST ? `https://${env.APP_HOST}` : env.RENDER_EXTERNAL_URL);
  if (!base) throw new Error("APP_URL / APP_HOST is not set");
  const url = new URL(base);
  if (url.protocol !== "https:" && env.NODE_ENV === "production")
    throw new Error("callback URL must be https");
  return url.origin;
}

export const FHB_CALLBACK_PATH = "/api/webhooks/fhb";

export function fhbStockNotifyUrl(connectionId: string, base = publicBaseUrl()): string {
  return `${base}${FHB_CALLBACK_PATH}/${connectionId}/stock/${fhbCallbackToken(connectionId, { kind: "stock" })}`;
}

export function fhbOrderNotificationUrls(
  connectionId: string,
  fulfillmentId: string,
  base = publicBaseUrl(),
): Record<FhbNotificationEvent, string> {
  return Object.fromEntries(
    FHB_NOTIFICATION_EVENTS.map((event) => [
      event,
      `${base}${FHB_CALLBACK_PATH}/${connectionId}/order/${fulfillmentId}/${event}/${fhbCallbackToken(
        connectionId,
        {
          kind: "order",
          fulfillmentId,
          event,
        },
      )}`,
    ]),
  ) as Record<FhbNotificationEvent, string>;
}

const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Parses and authenticates the path after /api/webhooks/fhb/: `{connectionId}/stock/{token}` or
 * `{connectionId}/order/{fulfillmentId}/{event}/{token}`. Pure (no database): a forged URL costs one HMAC.
 */
export function authenticateFhbCallbackPath(
  segments: string[],
): { connectionId: string; scope: FhbCallbackScope } | null {
  if (!segments.every((s) => SEGMENT.test(s))) return null;
  if (segments.length === 3 && segments[1] === "stock") {
    const [connectionId, , token] = segments as [string, string, string];
    const scope: FhbCallbackScope = { kind: "stock" };
    return verifyFhbCallbackToken(connectionId, scope, token) ? { connectionId, scope } : null;
  }
  if (segments.length === 5 && segments[1] === "order") {
    const [connectionId, , fulfillmentId, event, token] = segments as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (!(FHB_NOTIFICATION_EVENTS as readonly string[]).includes(event)) return null;
    const scope: FhbCallbackScope = { kind: "order", fulfillmentId, event: event as FhbNotificationEvent };
    return verifyFhbCallbackToken(connectionId, scope, token) ? { connectionId, scope } : null;
  }
  return null;
}
