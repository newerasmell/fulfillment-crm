# Progress log

Claude Code updates this file at the end of every task: what was done, what is next, decisions taken,
open questions.

## Current phase
Phase 0 — Foundation (in progress)

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

## Open questions
See SPEC.md §11.

## Done
- P0-01 scaffold (pnpm, Next.js App Router, worker entry, ESLint+Prettier, Vitest, Playwright, pino, scripts).
- P0-02 docker-compose (Postgres 16 + pgvector), `.env.example`, throwaway test DB per `pnpm test` run (tests/test-db.ts).
- P0-03 full Prisma schema for SPEC §3 incl. enums (LiveMode, CrmOrderStatus, OutboundStatus…), ERD comment.
- P0-04 tenant-scoped DB client + RLS migration; isolation tests (src/server/db/tenant-isolation.test.ts).

## Next
- Phase 0 tasks.
