# Wave 2 — builder notes (decisions, interfaces, behaviour changes)

Verbatim hand-off notes of each wave-2 agent, in order. Synthetic data only.

## build:core
BLOCKED: []
Branch wave2/core in /home/user/wt/w2-core has 3 commits. Nothing was pushed. Mark P4-01, P4-02 and P4-03 [x].

INTERFACES FOR THE NEXT AGENTS
- src/server/pipeline (P4-03)
  - transition(tx, {orderId, to, cause, actor, source?, reason?, meta?, onlyFrom?, mode?}) and transitionOrder(accountId, input) are the only way to change Order.status.
  - actor is {kind:"user",userId} | {kind:"system"} | {kind:"ai",level,policyId?}.
  - mode "strict" (default for user and ai) throws TransitionError with code transition_not_allowed, transition_guard:<g> or transition_race. mode "follow" (default for system) returns {changed:false, reason}.
  - Every move writes an OrderEvent in the same transaction. Moves by a user also write an AuditLog entry "order.status".
  - Other helpers: recordInitialStatus (cause "created"), followShipment (vendor, forward only), registerGuard, and RULES / isAllowed / allowedTransitions / nextSteps for the decision bar.
  - Causes: check_start, check_result, approve, reopen, hold, release (ON_HOLD → IMPORTED), cancel, shopify_cancelled, shopify_fulfilled, queue, submitting, submit_failed, vendor. VENDOR_FROM is the old euShipments ORDER_FROM table; statuses.ts re-exports it.
  - Guards:
    - approve: an AI actor needs level L2, and there must be an OrderCheck with hardCount 0 (no_check / hard_findings).
    - cancel: users only, never with an active shipment (any Fulfillment not SUBMIT_FAILED/CANCELLED).
    - release: refused for orders tagged shopify-test.
  - P4-04: editing an order must call checkOrder again. P4-06: Fulfill should approve with cause "approve" and then call the existing submitFhbOrder / queueEuOrder, which now move the order to QUEUED themselves. The outbox liveMode gate is unchanged.
- src/server/routing (P4-02)
  - routeOrder(accountId, orderId) returns a RoutingDecision: connectionId/Name/Type, via rule|stock_fallback|none, ruleId, ruleNumber, ruleName, crossCompany, carrier {parcelService, courierId, serviceName, deliveryPointPolicy}, stock {status ok|insufficient|unknown, lines}, explanation {bg, en} (e.g. "Правило 3: BG + COD → FHB Kika; наличност OK"), and per-rule steps.
  - loadRoutingContext + routeWithContext handle bulk; evaluateRouting / checkStock / describeMatch are pure.
  - RoutingRule.match is the Zod RuleMatch {storeIds, countries, payment, tags (any), excludeTags, productIds (any line), requireStock}.
  - Order of evaluation: priority ascending, first match wins, requireStock skips a rule without stock. The stock fallback picks an enabled FHB_V3/EUSHIPMENTS connection with stock for every line, own company first. FHB_JOY is never a routing target.
  - Admin: list/create/update/delete/moveRoutingRule, permission routing.manage (OWNER/ADMIN), audited as routing.rule_created/updated/deleted/moved. Restricted members see and edit only rules whose connection and stores are in their companies.
  - UI is /routing (already in the Настройки nav), with a "Пробвай с поръчка" box.
- src/server/checks (P4-01)
  - validateOrder(accountId, orderId, {connectionId?, persist?, now?}) returns {routing, connectionId, findings, hardCount, softCount, normalised {phone E.164, country}} and upserts the OrderCheck.
  - Finding shape: {code, severity hard|soft, source order|routing|stock|fhb|eushipments, field, message_bg, message_en, suggestedFix?:{field, value}}. Findings are sorted hard first. euShipments codes are prefixed "eushipments."; "block" maps to hard.
  - Vendor checks use the new read-only previewFhbOrderFindings (consumes no variable symbol) and previewEuOrderFindings (extracted from queueEuOrder; behaviour unchanged).
  - checkOrder(accountId, orderId, {actor, connectionId?}) moves an order from IMPORTED/NEEDS_REVIEW/READY/APPROVED/SUBMIT_FAILED to CHECKING, then to READY when there are zero findings or NEEDS_REVIEW when there are any. Orders in other states are only re-validated.
  - checkOrderAs(actor, ...) needs orders.review and the order in the actor's company scope. latestOrderCheck(accountId, orderId) returns the stored check.
  - Queues: orders.check (stately, singletonKey orderId) and the orders.checkSweep cron (*/5), which picks up IMPORTED orders and orders stuck in CHECKING for more than 10 min.

DECISIONS AND BEHAVIOUR CHANGES TO RECORD
1. FHB now moves Order.status. Before, only Fulfillment.status moved (apply.ts said "left to P4-03"). Now: submitFhbOrder sets APPROVED/READY/SUBMIT_FAILED → QUEUED, which matches euShipments. A rejected create moves QUEUED/SUBMITTING → SUBMIT_FAILED. Order views follow the shipment forward only. An FHB or euShipments "deleted at vendor" still leaves the Order alone. A new test covers this.
2. Once deployed, the worker's check sweep will move existing production orders that are IMPORTED to CHECKING and then READY or NEEDS_REVIEW. Nothing is auto-approved or sent.
3. Findings live in OrderCheck. Review rows are left for P4-05, which should copy findings at decision time.
4. A successful phone normalisation is not a finding. The E.164 value is in OrderCheck.normalised, so the UI can show original → corrected. Order-level COD rules need a CountrySetting for the destination, otherwise there is a hard finding.
5. READY means no findings at all. Soft-only orders go to NEEDS_REVIEW.

OPEN
- The auditor subagent could not be run here; run it on wave2/core.
- INTEGRATION_NOTES may want a line saying vendor statuses now drive Order.status for FHB too.

## fix:core
BLOCKED: []
Wave 2 core audit fixes (commit 0b1d5e6).
- The pipeline now gates submission. queueGate(tx, {orderId, userId, source, connectionId, rearmQueued}) must be called, with lockForUpdate('Order', id) held, before any vendor-write row is created. Only APPROVED or SUBMIT_FAILED orders can be queued; READY can no longer be queued. Wave-2 Fulfill/bulk code (P4-05/P4-06) must approve first and then submit.
- Re-checking an APPROVED order means reopen (to NEEDS_REVIEW) and then checkOrder. checkOrder on an APPROVED order only validates and stores the check; the status does not change.
- Approval needs a check whose stored fingerprint (OrderCheck.normalised.orderFingerprint) matches the current order data. Any edit to the recipient, address, amounts/COD, tags or lines needs a re-check. Approve accepts an optional meta.connectionId, which must equal check.connectionId (guard check_connection_mismatch). Checks stored before this change have no fingerprint and count as stale (dev data only).
- A Shopify re-import that changes the data of a CHECKING/NEEDS_REVIEW/READY order moves it to IMPORTED (new system cause data_changed), and the existing sweep checks it again.
- An AI actor is now {kind:'ai', level, policyId} with policyId required. The guard loads an enabled L2 AiPolicy with decisionType 'order_approval' (exported as AI_APPROVAL_DECISION). The P4/AI layer must create and use that decision type.
- New TransitionError codes the UI should translate: transition_not_allowed (submit gate), transition_guard:check_stale, transition_guard:check_connection_mismatch, transition_guard:ai_policy_missing / ai_policy_disabled / ai_policy_not_l2, transition_guard:active_shipment.
- Routing: a restricted admin no longer sees or changes rules that name another company's store. They cannot move a rule past an out-of-scope neighbour (routing_out_of_scope). The move action still swallows errors, as it did before.
- Not changed: the LOW finding on fhb/apply.ts:308 is wrong. `message` is already built with scrubText(...) a few lines earlier (the 'rejected' case at about line 285), so the .slice(0, 500) is applied to scrubbed text. Left unchanged.
- Follow-up (not done): the submit gate does not check that a fresh OrderCheck exists for the target connection, because the vendor queue functions run their own pre-flight for the actual connection. If routing/stock findings must also bind at submit time, add a queue guard and update the FHB/euShipments test fixtures, which create APPROVED orders without an OrderCheck. A reship after a vendor CANCELLED is refused by the gate, since CANCELLED is terminal; reships need their own cause when that feature is built.

## build:review
BLOCKED: []
P4-04 and P4-05 are done, in one commit because the decision bar and the Review records depend on each other.

Built:
- src/server/review: diff.ts (pure; address edit schema, field-level diff), reasons.ts, service.ts (editOrderAddress, previewAddress, decideOrder), detail.ts (getOrderReview, listReviews).
- src/app/actions/review.ts.
- src/app/(app)/orders/[id]/page.tsx + review-ui.tsx (AddressEditor, ApplyFixButton, RecheckButton, DecisionBar, LazyDetails).
- src/app/(app)/orders/reviews: review list and reason-code admin.

Decisions:
1. "Блокирай" maps to the existing pipeline cause `cancel`: the order goes to CANCELLED in the CRM only and Shopify is not touched. The Review decision is CANCEL. Reasons:
   - The pipeline has no user path to BLOCKED; BLOCKED is vendor-reported, and the Shopify PRE_APPROVAL set excludes it.
   - The ReviewDecision enum has no BLOCK value.
   - Cancel stays refused while a shipment is active.
   - Open question for the owner: if they want a reversible operator block instead, the core track needs a new pipeline cause/status and a new enum value.
2. Review session model:
   - The first address edit opens an undecided Review (decision null) for that reviewer, holding the findings seen at that moment.
   - Each edit merges into its diff: the first `from` and the last `to` per field are kept, a field edited back to its start drops out, and each change records `via` = manual or suggested_fix:<code>.
   - The decision closes the Review in the same transaction as the strict transition. A refused move rolls back the Review too.
   - Approving with a non-empty diff is stored as EDIT_AND_APPROVE.
3. Approve:
   - Refused while the stored check has hard findings: an explicit "hard_findings" check plus the existing pipeline guards (no_check, check_stale).
   - It only moves the order to APPROVED. No Fulfillment or outbox row is created.
4. Address editing:
   - Allowed only in IMPORTED, NEEDS_REVIEW, READY and ON_HOLD.
   - Optimistic version check (Order.updatedAt), so a newer order is refused as "stale", not overwritten.
   - Updates shippingAddress, Order.phone and Order.countryCode. The original stays in shippingAddressOriginal and is shown crossed out.
   - Audited as order.address_edited, then re-checked with checkOrder.
   - The Shopify import now also keeps an operator-corrected phone and country, not only the address.
5. Suggested fixes: one click only for shippingAddress.* and phone. A COD suggestion is shown as text only, with the note that COD is corrected in Shopify.
6. Time spent:
   - Measured from the server-rendered openedAt, kept in client state so it survives refreshes after edits.
   - Clamped to 0–2 h; a future timestamp is ignored. The client could forge it, but it is training data only.
7. Reason codes:
   - Built-in defaults (approve/hold/block plus "other", which requires a note) apply until the first admin change, which stores them.
   - Codes are deactivated, never deleted. Required for hold and block, optional for approve.
8. New permissions:
   - orders.rawPayloads (OWNER, ADMIN): raw Shopify JSON, routing JSON and outbox payload/response on the order detail, mounted only when opened.
   - reviews.read (OWNER, ADMIN, OPERATOR).
   - reviews.reasonCodes (OWNER, ADMIN).
9. Review list: /orders/reviews, linked from the order detail header. No sidebar item was added. It filters by decision, reason, reviewer, date range and order number, scoped to the member's companies, and shows counts per decision and the average time.

E2E: seeded in its own synthetic group with its own OWNER (tests/e2e/seed-review.ts, env E2E_REVIEW_EMAIL/PASSWORD/TOTP) so other specs' order counts do not change.

Hand-off to the Fulfill track (P4-06): put the Fulfill action in the order detail's DecisionBar area for APPROVED orders. getOrderReview already returns `fulfillments` and `check.connectionId`.

Not done:
- An index on Review(accountId, orderId/decidedAt). Not needed at current volume; it would change an existing model, so I left it out.
- The FHB/euShipments payload preview ("show what will be sent") on the detail page. It is not in the P4-04 text; for orders already sent, the outbox payload is shown in the raw section.

## fix:review
BLOCKED: []
P4-04/P4-05 audit fixes (wave2/review, commit 5aa6bba). Decisions taken: (1) A review cycle ends on any pipeline move out of IMPORTED/CHECKING/NEEDS_REVIEW/READY. One decision closes the review for every reviewer: the diffs of the cycle's open sessions are merged into the decider's Review, and the other sessions are marked reasonCode='superseded' with decidedAt set. Their decision stays null, so lists and the timeline never show them. (2) The Shopify re-import keeps an operator's correction when the address, Order.phone or countryCode differs from what the last import derived. No contactEditedAt column, so no schema change. (3) The payload preview is built from the queue functions' own pre-flight and builders, read-only. The FHB preview omits the notification URLs (HMAC tokens), which are added at submit time. It is shown for IMPORTED, NEEDS_REVIEW, READY, ON_HOLD, APPROVED and SUBMIT_FAILED. After that, the gated raw outbox section shows what was actually sent. (4) Блокирай stays irreversible (CANCELLED in the CRM). It now opens the operator task 'blocked_in_crm_open_in_shopify', and the UI needs an explicit acknowledgement. The open question for the owner is still open: should 'block' be reversible, or should it cancel in Shopify? (5) Raw payloads are never in the page or RSC payload. They load per section through rawPayloadAction (orders.rawPayloads), with tokens after /api/webhooks/ redacted. (6) releaseAction now calls the new releaseOrder service (strict, scoped, re-checks). All audit findings verified as correct; none rejected.

## build:fulfill
BLOCKED: []
BACKLOG: mark P4-06, P4-07 and P4-08 [x].

DECISIONS
- P4-06 Fulfill (src/server/fulfill)
  - Fulfill acts only on orders that are APPROVED, SUBMIT_FAILED or QUEUED. QUEUED only re-arms a request that never left: a dry run or a refusal.
  - The warehouse is the one the order was approved for (OrderCheck.connectionId), or the warehouse of the shipment already queued.
  - Fulfill refuses in these cases:
    - the check fingerprint no longer matches the order (check_stale);
    - the connection is disabled or READ_ONLY. This is an extra early refusal; the outbox sender is still the gate that counts.
  - validateOrder is re-run against that connection without storing the result:
    - a hard finding gives BLOCKED;
    - a soft finding that was not in the reviewed check gives NEEDS_ACK until the operator acknowledges it.
  - Then the existing submitFhbOrder or queueEuOrder is called. Carrier settings from routeOrder are used only when the routed warehouse is the approved one.
  - Duplicate guard is in the database: the pipeline queueGate under the Order row lock, plus the unique keys on Fulfillment and the outbox. The loser of a race gets SKIPPED/already_submitted.
  - Tests cover a double click, two operators at once, and bulk plus single on the same order; each ends in exactly one Fulfillment and one OutboundRequest.
  - Bulk and single both create a persisted FulfillBatch:
    - /orders/fulfill/[id] drives it step by step and shows a result per order;
    - it can be reopened and resumed;
    - items are claimed PENDING → RUNNING, and a RUNNING item older than 5 min can be picked again;
    - at most 200 orders per batch.
  - CANARY confirmation:
    - confirmFulfillCanary works like the outbox's confirmCanary (same lock order, conditional write) but also accepts a request still PENDING, so the click can follow Fulfill directly;
    - the dialog shows the exact stored payload and today's remaining cap, counted the way the sender counts;
    - anyone with outbox.confirmCanary sees the payload, because the confirmer must see what is sent. This is wider than outbox.payloads (OWNER/ADMIN).
    - In bulk, CANARY orders are queued too, but each still needs its own click.
- P4-07 Shopify write-back (src/server/fulfill/writeback.ts, src/integrations/shopify/fulfillments.ts)
  - The outbox table is bound to FulfillmentConnection, so the store side has its own outbox, ShopifyWriteBack, with the same discipline.
  - The sweep (cron shopify.writeBack, every 2 min) creates one row per shipment when:
    - the shipment is SHIPPED, DELIVERED or COD_PAID and has a tracking number;
    - the order came from Shopify;
    - the store is not READ_ONLY;
    - the shipment shipped within the last 14 days, so raising a store's mode never notifies customers about old parcels.
  - The sender gates on the store's current writeBackMode:
    - READ_ONLY → REFUSED, nothing read or sent;
    - DRY_RUN → reads the order's fulfillment orders and records the exact {mutation, variables}, which the order page shows;
    - LIVE → sends fulfillmentCreate;
    - the account kill switch or global pause → PAUSED.
  - DRY_RUN records are re-armed and sent once the store goes LIVE (inside the window).
  - Before every send and every retry, the order's fulfillments are read back by tracking number; a match means done.
  - The mutation is sent with maxRetries: 0, because the existing ShopifyClient retries 5xx on every call.
  - Shopify graphql_error, auth_failed or userErrors → FAILED plus a task. Any other failure → read back; if that also fails → UNCERTAIN plus a CRITICAL task.
  - One fulfillmentCreate only covers fulfillment orders at a single location; a shipment spanning several locations becomes an operator task (multiple_locations).
  - Customer notification follows Store.notifyCustomer.
  - Each outcome is written as a FulfillmentEvent (source shopify.writeback) and to the audit log.
- P4-08 Alerts and tasks (src/server/alerts, /alerts)
  - One list with categories mapped from the kinds other modules write, plus company scope.
  - Assign to me and resolve with a required note; history in AlertNote, every action in the audit log.
  - The cron alerts.sweep (every 10 min) raises and auto-resolves order_blocked, order_unknown, order_submit_failed and order_stuck.
  - Default stuck thresholds, in hours: CHECKING 1, APPROVED 24, QUEUED 4, SUBMITTING 1, ACCEPTED 48, PROCESSING 72, SHIPPED 240. Override with env ALERT_STUCK_HOURS as JSON.
  - Notifications go through a provider interface, configured by env only:
    - Telegram: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (Bot API sendMessage).
    - Email: ALERT_EMAIL_WEBHOOK_URL (https), ALERT_EMAIL_TO and optional ALERT_EMAIL_WEBHOOK_TOKEN: a JSON POST {to, subject, text} to an HTTP mail relay, so no new SMTP dependency.
    - NOTIFY_MIN_SEVERITY defaults to CRITICAL.
    - An unset channel is disabled and logged.
    - Each (alert, channel) is claimed once, so nothing is notified twice.
    - Messages hold only the title, severity and a link, never the alert body.
  - New permission alerts.manage: OWNER, ADMIN, OPERATOR, WAREHOUSE.
  - Начало gets a "Сигнали и задачи" attention card, and the header bell links to /alerts.

OPEN QUESTIONS FOR THE OWNER
1. Which mail relay or provider sends the alert emails? The code expects an HTTP endpoint at ALERT_EMAIL_WEBHOOK_URL.
2. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID on the Render worker if you want Telegram alerts.
3. At GATE P1-G1 the Shopify app needs write_merchant_managed_fulfillment_orders (it is already in SPEC §4).
4. Are the stuck-hours defaults right?

LEFT / FOLLOW-UPS
- The routing rule's deliveryPointPolicy is not turned into a pickup point at Fulfill. An FHB or euShipments PUDO order without a point is blocked by the vendor validators.
- REFUSED write-back rows have no "send again" button.
- Alert body text is not shown in the list.
- Saved views for the alerts list.

Before merging, an auditor pass over the three commits is still needed.

## fix:fulfill
BLOCKED: []
Wave 2 fulfill track, audit fixes (commit 067bf36):
- Acknowledging warnings: the server action signature changed to retryFulfillItemAction(batchId, itemId, acknowledgedCodes: string[]). The UI sends the codes it shows on the row, and the server keeps only those that are also in the item's STORED NEEDS_ACK findings. A fresh validation never widens the set.
- FHB: fulfillOrder now passes acknowledgedCodes (reviewed check ∪ acknowledged) to submitFhbOrder instead of acknowledgeWarnings:true. FHB pre-flight codes are the same strings in the validator engine (fromFhb keeps f.code), so they can be compared directly.
- Routing change: implemented as a soft routing.changed finding (NEEDS_ACK), not BLOCKED, so an order whose rules changed after approval is not stuck. The message names both warehouses and carriers. Once acknowledged, the order goes to the APPROVED warehouse with the carrier that applies there now (null if the rule moved away). A manual approval for a non-routed warehouse (routed elsewhere already at review) is not flagged, because nothing changed relative to what was reviewed.
- Leftover QUEUED shipment at another connection: BLOCKED connection_mismatch, with a hard routing.connection_mismatch finding.
- CANARY: confirmCanaryAction(requestId, payloadHash). The hash is the sha256 of the stored jsonb payload; a matching hash plus a conditional write on updatedAt is required.
- Shopify existingFulfillment, deviation from the auditor's fix: 2026-10 FulfillmentStatus is CANCELLED, ERROR, FAILURE, SUCCESS (OPEN and PENDING no longer exist). The code excludes CANCELLED, ERROR and FAILURE, and counts every other status (SUCCESS, or one Shopify adds later) as done. An unknown status therefore never leads to a second fulfillment.
- graphql_error counts as definite only when every errors[].extensions.code is in DEFINITE_GRAPHQL_CODES (src/integrations/shopify/fulfillments.ts).
- Alert sweep: when an order has no OrderEvent into its current status (it was imported straight into it), any earlier resolution of that alert kind suppresses a new one. Real transitions always write an event, so a new episode raises a new alert.
- Process: I had no auditor subagent tool in this run, so CLAUDE.md's "auditor before every commit" step was not performed by me. The independent audit these fixes answer was the review. Full checks were re-run on HEAD: typecheck, lint, 798 unit tests and 3 e2e tests all pass.
