# Phase 1 audit

Scope: P1-01 … P1-06 (Shopify). Independent `auditor` subagent, round 1. Every CRITICAL/HIGH and MEDIUM finding
was fixed with a test; LOW items are fixed or recorded below.

## Findings and fixes

| Severity | Finding | Fix |
|---|---|---|
| CRITICAL | Order queries exceeded Shopify's 1000-point single-query cost (`orders(first:50)` × `lineItems(first:250)`) — every import would fail in production | Orders 4 per page with 20 lines; remaining lines paged by `ORDER_LINES_QUERY`; variants 50 per page with one barcode; product variants paged. Conservative cost estimator + test for every query (`src/integrations/shopify/query-cost.test.ts`) |
| HIGH | pg-boss queues used the default `standard` policy, under which `singletonKey` deduplicates nothing | Shopify queues are `stately` (one queued + one running per key); `ensureQueues` warns when an existing queue's policy differs; test proves the second enqueue is dropped. `outbox.send` (created earlier, policy immutable) stays `standard` — harmless, the sender claims atomically; comment corrected |
| HIGH | Concurrent imports of one order (webhook + reconcile) could race: duplicate create (P2002) or an older version committed last | Transaction-scoped advisory lock per (account, store, order) before the read; concurrency test with three versions |
| HIGH | After approval, Shopify updates still overwrote COD amount, totals and recipient identity | After approval only Shopify's status fields, `raw` and `shopifyUpdatedAt` change; meaningful differences (lines, address, totals, outstanding, gateways, contact, cancellation) open operator tasks |
| MEDIUM | COD gateway with nothing outstanding fell back to collecting the full total | COD only when money is owed; otherwise PREPAID + task `cod_nothing_outstanding` |
| MEDIUM | Presentment (customer-currency) amounts were not fetched | `presentmentMoney` and `presentmentCurrencyCode` are fetched and kept in `raw` (local-currency COD columns come with phase 4) |
| MEDIUM | Any credential of the group could be reused as a store's Shopify app | Reuse only if it decrypts to a Shopify app credential (`invalid_credential` otherwise). Store creation is OWNER/ADMIN, who are never company-restricted (P0-13) |
| MEDIUM | `createProductFromVariant` created the product before the scope check | Scope check, product, EAN and link in one transaction |
| MEDIUM | Re-linking a variant left open order lines on the old product | A person's link moves lines of orders not yet sent anywhere; auto-match fills only empty lines |
| MEDIUM | Webhook body read fully before the size check (chunked); every forged request decrypted the store secret | Streamed read with a byte cap; decrypted secret cached 5 min per credential id |
| MEDIUM | Webhook subscription creation bypasses the mode gate | Documented exception in INTEGRATION_NOTES §6 (configuration only, creates missing topics for our URL, never edits others) |
| MEDIUM | Missing tests (stores, route, races, dedupe, COD) | `stores.test.ts`, `route.test.ts`, shopify race/COD/test-order/line-paging/relink tests, queue dedupe test |
| LOW | "Changed after approval" tasks on every update | Only meaningful fields compared |
| LOW | Shopify test orders could be approved | Imported as ON_HOLD |
| LOW | Full PII webhook body stored | Only the pointer ids are stored |
| LOW | Case-insensitive SKU match nondeterministic | Auto-match only when exactly one master fits |
| LOW | 60 s reconcile overlap too short for the search index | 10 minutes |
| LOW | 2026-10 fields unverified | `barcodes` connection, `webhookSubscriptions(uri:)` / `webhookSubscriptionCreate(webhookSubscription:{uri})`, `Customer.defaultEmailAddress/defaultPhoneNumber`, `Order.risk`, `presentmentCurrencyCode`, `MoneyBag.presentmentMoney` checked against the schema on 2026-11-02 |

Also found by the e2e suite before the audit: the "operator left the address untouched" check compared JSON text,
which Postgres `jsonb` reorders — fixed with a key-order-insensitive comparison and a regression test.

## Round 2 (fixes re-audited)

| Severity | Finding | Fix |
|---|---|---|
| HIGH | `BLOCKED` was treated as pre-approval, but it is a vendor-reported state of an order the warehouse already holds — Shopify edits would rewrite COD, recipient and lines there | `BLOCKED` removed from the pre-approval and re-linkable sets (shared in `src/server/shopify/statuses.ts`); test |
| MEDIUM | 4 orders per page and an unbounded backfill could outlive the 1 h job expiry | 10 orders × 5 lines per page (rest paged); backfill split into week windows, one job each |
| MEDIUM | One failing order aborted the whole sync and froze the cursor; Prisma's 5 s transaction default too short | Per-order failure → task `shopify_import_failed`, sync continues; import transaction 30 s / wait 15 s; tests |
| LOW | Secret cache missed in-place rotation (same credential id) | Cache keyed by credential id + `updatedAt` |
| LOW | Stately + retries: a second failing sync job may skip its retries and dead-letter (pg-boss inserts the retry with `ON CONFLICT DO NOTHING`) | Accepted and documented: sync jobs are re-created by the 15-minute cron; a dead-lettered sync is informational |
| LOW | Policy mismatch on an existing queue only warned | Empty queue is recreated with the right policy; a queue holding pending jobs stops the start |
| LOW | Line pages could mix two versions of an order edited mid-read | Each page's `updatedAt` is compared; on change the order is re-read (3 attempts); test |
