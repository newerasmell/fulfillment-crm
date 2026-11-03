import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Topics we subscribe to (GraphQL enum) and the header form Shopify sends them in (X-Shopify-Topic). */
export const WEBHOOK_TOPICS = [
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  "ORDERS_EDITED",
  "REFUNDS_CREATE",
  "PRODUCTS_UPDATE",
  "APP_UNINSTALLED",
] as const;
export type WebhookTopic = (typeof WEBHOOK_TOPICS)[number];

/** X-Shopify-Hmac-Sha256 = base64(HMAC-SHA256(raw body, client secret)). Constant-time compare. */
export function verifyWebhookHmac(rawBody: string | Buffer, header: string | null, clientSecret: string) {
  if (!header) return false;
  const expected = createHmac("sha256", clientSecret).update(rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(header, "base64");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** What a webhook asks us to re-read. The body itself is never trusted as data, only as a pointer. */
export type WebhookTarget =
  | { kind: "order"; gid: string }
  | { kind: "product"; gid: string }
  | { kind: "uninstalled" }
  | { kind: "ignore" };

const numericId = z.union([z.number(), z.string().regex(/^\d+$/)]).transform((v) => String(v));
const gid = z.string().startsWith("gid://shopify/");

export function webhookTarget(topic: string, payload: unknown): WebhookTarget {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (topic) {
    case "orders/create":
    case "orders/updated":
    case "orders/cancelled": {
      const g = gid.safeParse(p.admin_graphql_api_id);
      if (g.success) return { kind: "order", gid: g.data };
      const id = numericId.safeParse(p.id);
      return id.success ? { kind: "order", gid: `gid://shopify/Order/${id.data}` } : { kind: "ignore" };
    }
    case "orders/edited": {
      const id = numericId.safeParse((p.order_edit as Record<string, unknown> | undefined)?.order_id);
      return id.success ? { kind: "order", gid: `gid://shopify/Order/${id.data}` } : { kind: "ignore" };
    }
    case "refunds/create": {
      const id = numericId.safeParse(p.order_id);
      return id.success ? { kind: "order", gid: `gid://shopify/Order/${id.data}` } : { kind: "ignore" };
    }
    case "products/update": {
      const g = gid.safeParse(p.admin_graphql_api_id);
      if (g.success) return { kind: "product", gid: g.data };
      const id = numericId.safeParse(p.id);
      return id.success ? { kind: "product", gid: `gid://shopify/Product/${id.data}` } : { kind: "ignore" };
    }
    case "app/uninstalled":
      return { kind: "uninstalled" };
    default:
      return { kind: "ignore" };
  }
}

export const WEBHOOK_SUBSCRIPTIONS_QUERY = /* GraphQL */ `
  query WebhookSubscriptions($uri: String!) {
    webhookSubscriptions(first: 50, uri: $uri) {
      nodes {
        id
        topic
        uri
      }
    }
  }
`;
export const WebhookSubscriptions = z.object({
  webhookSubscriptions: z.object({
    nodes: z.array(z.object({ id: z.string(), topic: z.string(), uri: z.string() })),
  }),
});

export const WEBHOOK_CREATE_MUTATION = /* GraphQL */ `
  mutation WebhookCreate($topic: WebhookSubscriptionTopic!, $uri: String!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri, format: JSON }) {
      webhookSubscription {
        id
        topic
        uri
      }
      userErrors {
        field
        message
      }
    }
  }
`;
export const WebhookCreate = z.object({
  webhookSubscriptionCreate: z.object({
    webhookSubscription: z.object({ id: z.string(), topic: z.string(), uri: z.string() }).nullable(),
    userErrors: z.array(z.object({ field: z.array(z.string()).nullish(), message: z.string() })),
  }),
});

/** Verified against Admin API 2026-10: webhookSubscriptionDelete(id: ID!) → {deletedWebhookSubscriptionId, userErrors}. */
export const WEBHOOK_DELETE_MUTATION = /* GraphQL */ `
  mutation WebhookDelete($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedWebhookSubscriptionId
      userErrors {
        field
        message
      }
    }
  }
`;
export const WebhookDelete = z.object({
  webhookSubscriptionDelete: z.object({
    deletedWebhookSubscriptionId: z.string().nullable(),
    userErrors: z.array(z.object({ field: z.array(z.string()).nullish(), message: z.string() })),
  }),
});
