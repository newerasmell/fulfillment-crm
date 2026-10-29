You are running unattended as the autopilot builder. Nobody will answer questions. Never wait for input.

Your task: __TASK_ID__ from docs/BACKLOG.md:
__TASK_LINE__

Steps:
1. Read CLAUDE.md, docs/PROGRESS.md, the relevant parts of docs/SPEC.md and, for any vendor work,
   docs/integrations/INTEGRATION_NOTES.md plus the full reference for that vendor.
2. If the task is too big for one run, split it into __TASK_ID__a/b/c lines directly under it in
   docs/BACKLOG.md, do only the first part, and leave the rest open.
3. Implement with tests (unit + failure paths). Follow every non-negotiable rule in CLAUDE.md.
4. Run `pnpm typecheck && pnpm lint && pnpm test` until green.
5. Use the `auditor` subagent on `git diff HEAD` (uncommitted changes). Fix every CRITICAL and HIGH finding,
   re-run checks, and repeat the audit until VERDICT: PASS (max 3 rounds).
6. Mark the task `[x]` in docs/BACKLOG.md, add a short entry to docs/PROGRESS.md (what, decisions, open
   questions), then `git add -A && git commit -m "__TASK_ID__: <summary>"`.

If you cannot finish because something outside the repo is needed (credentials, a human decision, a
vendor answer, missing information in the references), do NOT guess and do NOT fake it: mark the task `[!]`,
put the reason on the next line indented, commit what is done, and stop.
Never call warehouse or Shopify production APIs. Never push. Never touch GATE lines.
