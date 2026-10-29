You are running unattended. The runner's independent check failed after task __TASK_ID__.
Fix the cause (not the test, unless the test itself is wrong — then explain why in PROGRESS.md).
Failure output (tail):
__FAIL_LOG__

Run `pnpm typecheck && pnpm lint && pnpm test` until green, then commit with message
"__TASK_ID__: fix checks". If impossible, mark the task [!] with the reason and commit.
