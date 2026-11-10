import { z } from "zod";

/**
 * Shopify order tags ("Липсващи артикули", owner request 2026-11-10), Admin GraphQL API 2026-10. Checked against the
 * 2026-10 Admin schema (Shopify schema tool): tagsAdd(id: ID!, tags: [String!]!) → TagsAddPayload {node, userErrors
 * {field message}} and tagsRemove(id: ID!, tags: [String!]!) → TagsRemovePayload {node, userErrors}; both support
 * Order ids. On orders they need the write_orders scope. Both are idempotent (adding a tag the order has, or
 * removing one it does not have, changes nothing), so a retry after an unclear answer is safe; the sender still
 * reads Order.tags first and skips what is already in place.
 */

export const ORDER_TAGS_READ_QUERY = `#graphql
query OrderTagsRead($id: ID!) {
  order(id: $id) { id tags }
}`;

export const ORDER_TAGS_ADD_MUTATION = `#graphql
mutation OrderTagsAdd($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) {
    userErrors { field message }
  }
}`;

export const ORDER_TAGS_REMOVE_MUTATION = `#graphql
mutation OrderTagsRemove($id: ID!, $tags: [String!]!) {
  tagsRemove(id: $id, tags: $tags) {
    userErrors { field message }
  }
}`;

const UserErrors = z.array(z.object({ field: z.array(z.string()).nullable(), message: z.string() }));

export const OrderTagsReadSchema = z.object({
  order: z.object({ id: z.string(), tags: z.array(z.string()) }).nullable(),
});
export type OrderTagsRead = z.infer<typeof OrderTagsReadSchema>;

export const OrderTagsAddSchema = z.object({
  tagsAdd: z.object({ userErrors: UserErrors }).nullable(),
});
export const OrderTagsRemoveSchema = z.object({
  tagsRemove: z.object({ userErrors: UserErrors }).nullable(),
});

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Pure: what still has to change on an order with `current` tags. Tags compare case-insensitively (Shopify keeps
 * the spelling a person typed): every spelling of a tag to remove is removed, a tag to add is skipped when any
 * spelling of it is already there.
 */
export function tagDelta(current: readonly string[], add: readonly string[], remove: readonly string[]) {
  return {
    remove: current.filter((t) => remove.some((r) => same(r, t))),
    add: add.filter((a) => !current.some((t) => same(t, a))),
  };
}

/** Pure: the order's tags once the change is applied (for our local copy after a send). */
export function applyTagChange(
  current: readonly string[],
  add: readonly string[],
  remove: readonly string[],
) {
  const kept = current.filter((t) => !remove.some((r) => same(r, t)));
  return [...kept, ...add.filter((a) => !kept.some((t) => same(t, a)))];
}
