# Phase 0 audit

Scope: `27991dd...HEAD` (P0-01 … P0-12). Independent `auditor` subagent, three rounds plus one pre-phase audit of
the database layer. Every CRITICAL/HIGH finding was fixed with a regression test; the round-3 fixes are verified
by tests that fail on the previous code (`src/server/outbox/outbox-races.test.ts`) but were not audited a fourth
time (the process allows three rounds).

## Findings and fixes

| Round | Severity | Finding | Fix |
|---|---|---|---|
| DB | CRITICAL | Rows could reference another account's parent (FK checks ignore RLS) | Composite `(accountId, id)` foreign keys on every business relation |
| DB | HIGH | `User` reachable through `accountDb()` | Account-less models refused on scoped clients |
| DB | HIGH | `$transaction` on scoped clients was not atomic | Disabled; `withAccountTransaction` is a real transaction with scope injection |
| DB | MEDIUM | Audit log mutable | Select/insert policies + trigger rejecting UPDATE/DELETE/TRUNCATE |
| 1 | HIGH | CANARY cap ignored in-flight/concurrent sends | Connection row lock; cap counts SENDING/SENT/UNCERTAIN |
| 1 | HIGH | Admins received new users' passwords/2FA keys | Single-use invitation links; people choose their own credentials |
| 1 | HIGH | Kill switch + resume dropped queued requests | Kill switch marks them HELD; explicit OWNER release |
| 1 | MEDIUM | Last-owner race, stale mode change, concurrent enqueue, sweep gaps, spoofable IP / lockout, dead letters across tenants, email enumeration, no startup DB-role check, worker on old schema | Row locks, idempotent enqueue, sweep re-picks, trusted IP + attempt-first limiter, per-account dead letters, neutral invitations, instrumentation check, worker pre-deploy migration + schema guard |
| 2 | HIGH | Held rows of one account could starve the sweep for everyone | Separate budgets for new work and re-picks; parked rows wait for their condition |
| 2 | MEDIUM | Hold semantics by timestamp, auto-send after a kill switch, inviter learns the 2FA key, deadlock, single-IP lockout, proxy hops assumed | HELD status, release action, stateless sealed enrolment key, one lock order, two-stage limiter, explicit `TRUSTED_PROXY_HOPS` |
| 3 | CRITICAL | Concurrent re-arm could reset an in-flight row → double send | Re-arm is `updateMany` conditional on the status at write time |
| 3 | HIGH | CANARY confirmation racing the kill switch could un-hold a request | Confirm takes the connection lock first and writes conditionally |
| 3 | MEDIUM | AWAITING_CONFIRMATION rows stuck after leaving CANARY | Mode change out of CANARY re-queues them (confirmations cleared) |

## Remaining (MEDIUM/LOW, accepted for now)

- Invitation links are bearer tokens held by the inviter until the app emails them: the inviter could open a link
  first and create the profile for that email (documented in PROGRESS.md; invite only trusted people).
- A distributed attacker (≥ 6 IPs) can still reach the 30-per-email login ceiling; per-IP limits stop single sources.
- `TRUSTED_PROXY_HOPS=1` must be confirmed against Render's real `X-Forwarded-For` layout at GATE P0-G1.
- shadcn/ui components are not used yet (plain Tailwind with the DESIGN.md tokens); added with the first complex widget.

## Tests

- Vitest: 17 files, 114 tests (real Postgres 16 + pgvector, throwaway database per run), incl. tenant isolation over
  every scoped model, RLS, auth/2FA/rate limits, RBAC matrix, vault, audit, invitations, outbox gate/sender/races,
  pg-boss retries and dead letters.
- Playwright: 9 end-to-end tests (login with 2FA, every screen, two companies + switching, invitation enrolment,
  write-only credentials, header controls, emergency stop), screenshots in `docs/screens/`.
- `pnpm render:validate`: render.yaml valid against Render's schema. Production build passes without any env.
