# Progress log

Claude Code updates this file at the end of every task: what was done, what is next, decisions taken,
open questions.

## Current phase
Phase 0 — Foundation (tasks done; waiting for GATE P0-G1)

## Decisions
- 2026-10-28: Production APIs only, no vendor sandboxes. Staged liveMode per connection (READ_ONLY → DRY_RUN → CANARY → LIVE).
- 2026-10-28: Stack and architecture per CLAUDE.md / SPEC.md. Vendor specs captured on this date.

- 2026-10-29: The GitHub repo is public. No real business data in git (see CLAUDE.md). Companies, stores,
  store codes, vendor accounts and routing are entered in the deployed CRM; only placeholders here.
- 2026-10-29: Hosting on the existing Render account, as new services (web, worker, Postgres) next to the
  existing ones.

- 2026-10-29: Versions pinned at build time: Next.js 16.4, React 19.3, Prisma 7.10 (driver adapter `@prisma/adapter-pg`,
  client generated to `src/generated/prisma`, config in `prisma.config.ts`), TypeScript 6.0 (typescript-eslint
  does not support TS 7 yet), Auth.js `next-auth@5` beta, pg-boss 12, Zod 4, Vitest 5, Playwright 1.63.
- 2026-10-29: Tenant isolation = `accountDb(accountId)` (injects/guards accountId in every query) + forced Postgres
  RLS on every table with `accountId` (`app.account_id` set per operation, `app.bypass_rls` only via `systemDb()`).
  The app must connect as a NON-superuser (superusers bypass RLS). Locally: role `crm_app`; on Render the default
  database user is not a superuser.
- 2026-10-29: pgvector is not a trusted extension: locally it is installed in `template1` (docker/db-init.sql) so
  the app role, the Prisma shadow DB and test DBs all have it. The first migration runs `CREATE EXTENSION IF NOT
  EXISTS vector` (Render allows it for the database user).
- 2026-10-29: Every relation between business tables is a composite FK (accountId, xId) → (accountId, id), so no row can
  point at another account's parent (FK checks ignore RLS). Optional relations use `onDelete: NoAction`; accounts are
  never hard-deleted. AuditLog is append-only (select/insert policies + trigger). Scoped clients disable `$transaction`
  and raw SQL; use `withAccountTransaction` (atomic, accountId injected) / `withSystemTransaction`.
- 2026-10-29: Auth = Auth.js credentials provider, JWT session (12 h) re-validated against the DB on every request
  (`sessionVersion`, `disabled`). 2FA (TOTP) is mandatory for every user, with replay protection; login rate limit
  5 failures / 15 min per email+IP, 20 per IP, 30 per email (only attempts that pass the per-IP limits count
  towards the email-wide one, so one source cannot lock a user out elsewhere); attempts are recorded before the
  check and purged hourly. The client IP
  is the right-most X-Forwarded-For entry (`TRUSTED_PROXY_HOPS`, default 1, for Render's proxy).
- 2026-10-29 (phase audit): people join through single-use invitation links (72 h; OWNER bootstrap 24 h). An admin
  never sees anyone's password or 2FA key: a new person chooses both on the link, an existing user must sign in
  and accept. The invitation page looks the same either way. The 2FA key for a new profile is generated on every
  page view and only travels sealed inside the form (30 min), so previewing a link reveals nothing reusable.
  Residual risk until links are emailed by the app: whoever holds a link (the inviter) could open it first and
  create the profile for that email — invite only people you would also give a password to.
- 2026-10-29: Outbox: `enqueueOutboundInTx` is idempotent per (connectionId, idempotencyKey); a DRY_RUN/REFUSED/FAILED
  row can be re-armed, a SENT/UNCERTAIN/in-flight one never. CANARY daily cap counts per UTC day. Global emergency
  pause: env `OUTBOX_PAUSED=1`; per-account kill switch = OWNER action (Складове и връзки → Аварийно спиране: all
  connections → READ_ONLY + pause, and every request still waiting is HELD with its CANARY confirmation cleared).
  Held requests never leave by themselves: an OWNER releases them explicitly and they are evaluated against the
  current mode (READ_ONLY refuses, CANARY asks again). Lock order is connection row → request row everywhere, so
  sender, kill switch and mode changes cannot deadlock; the CANARY cap counts in-flight and UNCERTAIN sends.
  The sweep fetches new work first with its own limit; parked rows are re-picked only when their condition can
  have changed (next UTC day for the cap, lifted pause).
- 2026-10-29: Re-arming a request and confirming a CANARY request are both conditional writes (status checked at
  write time, connection locked first), so a stale read can never resurrect an in-flight or held request. Leaving
  CANARY re-queues requests that were waiting for a click or for the next day's cap. Phase audit: docs/audits/phase-0.md.
- 2026-10-29: Review.embedding is `vector(1024)` (Voyage voyage-3.5 default size); revisit before P8-01 if another
  embedding model is chosen (changing it later needs a migration on a populated table).
- 2026-10-29: Sidebar per DESIGN.md plus four phase-0 admin entries under Настройки (Фирми и потребители, Ключове за
  достъп, Одит лог, Системни задачи). shadcn/ui components are added when the first complex widget needs one
  (dialogs/tables in phase 1); the phase-0 shell uses Tailwind with the DESIGN.md tokens.
- 2026-10-29: Render Blueprint in region `frankfurt`, plans starter/starter/basic-256mb; migrations run as
  `preDeployCommand` on web AND worker (a failed migration stops the deploy instead of crash-looping); the worker
  also refuses to start if a migration is missing, and the web app refuses to start on an RLS-bypassing DB role.

- 2026-11-02 (owner decision): the tenant is the business GROUP (Account); companies (Company) live inside it.
  Products and stock are group-wide so another company's warehouse can serve an order — recorded in the CRM only
  (no intercompany invoicing yet). Staff can be limited to companies (permission, not a DB wall); owners see all.
  Companies are archived, never deleted. companyId on Store/FulfillmentConnection/Order is nullable until the
  backfill migration has run everywhere; a later migration makes it NOT NULL.
- 2026-11-02: GATE P0-G1 in progress: Render web + worker + Postgres live (Frankfurt); owner enrolment pending.

- 2026-11-02 (P1-01, Shopify docs checked via the Shopify dev docs): client credentials grant confirmed —
  POST https://{shop}/admin/oauth/access_token (form: client_id, client_secret, grant_type=client_credentials),
  works only when the Dev Dashboard app and the store are in the same Shopify organisation (`shop_not_permitted`
  otherwise), token valid 24 h (expires_in 86399), refreshed by repeating the request. Webhooks are signed with
  HMAC-SHA256 of the raw body using the app's client secret (X-Shopify-Hmac-Sha256); deduplicate on
  X-Shopify-Webhook-Id. API version pinned to 2026-10 (latest stable, supported until 2027-10-16).
  WebhookSubscriptionInput uses `uri` in 2026-10. Stores outside the organisation would need the
  authorization-code flow — not built until a store needs it.

- 2026-11-02 (P1-02..06): Shopify 2026-10 schema checks — Customer has no email/phone (use
  `defaultEmailAddress.emailAddress` / `defaultPhoneNumber.phoneNumber`); ProductVariant has no `barcode`
  (use `barcodes(first:N){nodes{value}}`); `Order.risk` is `OrderRiskSummary!` {recommendation, assessments};
  webhook topics ORDERS_CREATE/UPDATED/CANCELLED/EDITED, REFUNDS_CREATE, PRODUCTS_UPDATE, APP_UNINSTALLED;
  `orders/edited` carries `order_edit.order_id`, `refunds/create` carries `order_id`.
  Decisions: webhook bodies are only pointers — the worker re-reads the order/product from Shopify; dedupe key
  is `<storeId>:<X-Shopify-Webhook-Id>`; when one shop is connected in two groups, the HMAC decides which store
  sent it. Webhooks are registered by the worker against `https://$APP_HOST/api/webhooks/shopify` (APP_HOST comes
  from the web service in render.yaml). Order lines of not-yet-synced variants get a stub StoreVariantLink so the
  product sync / matching queue can attach them later. Manual variant links are never overwritten by auto-match.
  Before approval Shopify edits apply directly (lines, untouched address, cancellation); after approval they
  open operator tasks. Saved views in the orders list are URL-based for now (filters live in the query string).

## Open questions
See SPEC.md §11.

## Done
- P0-01 scaffold (pnpm, Next.js App Router, worker entry, ESLint+Prettier, Vitest, Playwright, pino, scripts).
- P0-02 docker-compose (Postgres 16 + pgvector), `.env.example`, throwaway test DB per `pnpm test` run (tests/test-db.ts).
- P0-03 full Prisma schema for SPEC §3 incl. enums (LiveMode, CrmOrderStatus, OutboundStatus…), ERD comment.
- P0-04 tenant-scoped DB client + RLS migration; isolation tests (src/server/db/tenant-isolation.test.ts); audit
  findings fixed (composite FKs, global models, real transactions, append-only audit log).
- P0-05 Auth.js email+password+TOTP, sessions, rate-limited login; e2e login with 2FA (tests/e2e/auth.spec.ts).
- P0-06 accounts, memberships, roles, account switcher, RBAC matrix (src/server/auth/rbac.ts) with tests.
- P0-07 credentials vault (AES-256-GCM, AAD-bound), write-only UI, log redaction; tests prove no secret leaks.
- P0-08 audit log service + UI list (Настройки → Одит лог).
- P0-09 pg-boss worker: queues, cron, retry/backoff, dead letters + view with redrive (Настройки → Системни задачи).
- P0-10 outbox + sender with the liveMode gate, CANARY confirmation + daily cap, kill switch, read-back on unknown
  outcome, UNCERTAIN tasks; duplicate-submit and concurrency tests.
- P0-11 i18n (bg default, en), shell per DESIGN.md, empty pages; Playwright smoke + screenshots in docs/screens/.
- P0-12 render.yaml (web, worker, Postgres) validated against Render's schema (`pnpm render:validate`), health
  endpoints `/api/health` and `/api/health/ready`; GitHub Actions CI (typecheck, lint, tests).

- P1-01 Shopify GraphQL client (client credentials token, cost-based throttling, retries, Zod).
- P1-02 Магазини: add store (company, domain, code, currency, countries, app credentials → vault), settings
  (COD gateways, SKU prefix, write-back / stock push modes — raising them is OWNER-only), credential rotation,
  connection test job, manual sync buttons.
- P1-03 `/api/webhooks/shopify` (raw-body HMAC, size cap, dedupe, fast 200) + processing and registration jobs.
- P1-04 order import (idempotent, out-of-order safe, COD detection, normalised + original address, risk, tags),
  15-minute reconcile cron (also re-queues stuck webhook events), backfill N days (audited).
- P1-05 variant import + SKU auto-match with prefix stripping; matching queue (Продукти): link to a master SKU or
  create the master product from the variant.
- P1-06 orders list (tabs with counts, search, store/country/payment filters, paging), read-only order detail,
  Начало with attention numbers, today vs yesterday KPIs, COD by currency, recent orders. E2E with synthetic
  fixtures (tests/e2e/shopify.spec.ts, seed in tools/e2e.ts).

## Next
- GATE P1-G1 (owner): Shopify Dev Dashboard → create one app in the organisation that owns the stores, the scopes
  in SPEC §4 plus protected customer data access (otherwise addresses come back empty), release a version and install it on every store; then in
  the CRM Магазини → Добави магазин enter domain, code, currency, countries and the app's client ID + secret.
  The connection test, webhook registration, product sync and first order sync start automatically. Then set the
  SKU prefix and the COD gateway names per store and clear the matching queue in Продукти.
- Then phase 2 (FHB).
