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
  5 failures / 15 min per email, 20 per IP. New users get a generated password + TOTP key shown once.
- 2026-10-29: Outbox: `enqueueOutboundInTx` is idempotent per (connectionId, idempotencyKey); a DRY_RUN/REFUSED/FAILED
  row can be re-armed, a SENT/UNCERTAIN/in-flight one never. CANARY daily cap counts per UTC day. Global emergency
  pause: env `OUTBOX_PAUSED=1`; per-account kill switch = OWNER action (all connections → READ_ONLY + pause).
- 2026-10-29: Review.embedding is `vector(1024)` (Voyage voyage-3.5 default size); revisit before P8-01 if another
  embedding model is chosen (changing it later needs a migration on a populated table).
- 2026-10-29: Sidebar per DESIGN.md plus four phase-0 admin entries under Настройки (Фирми и потребители, Ключове за
  достъп, Одит лог, Системни задачи). shadcn/ui components are added when the first complex widget needs one
  (dialogs/tables in phase 1); the phase-0 shell uses Tailwind with the DESIGN.md tokens.
- 2026-10-29: Render Blueprint in region `frankfurt`, plans starter/starter/basic-256mb; migrations run as
  `preDeployCommand` (a failed migration stops the deploy instead of crash-looping the service).

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

## Next
- GATE P0-G1 (owner): Render → New → Blueprint → this repo; set CREDENTIALS_KEY in the `crm-secrets` group; after the
  first deploy run `pnpm owner:create --email … --name … --account "…"` in the web service Shell, add the other
  companies in Настройки → Фирми и потребители.
- Then phase 1 (Shopify).
