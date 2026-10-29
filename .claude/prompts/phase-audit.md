You are running unattended. Phase __PHASE__ is complete. Run a full phase audit:
1. Use the `auditor` subagent on `git diff __BASE__...HEAD`.
2. Fix every CRITICAL and HIGH finding with tests; re-run all checks until green.
3. Write docs/audits/phase-__PHASE__.md: findings, what was fixed, what remains (MEDIUM/LOW), test count
   and coverage summary.
4. Commit: "Phase __PHASE__ audit".
Never push, never call production APIs.
