#!/usr/bin/env bash
# PreToolUse guard for Bash. Exit 2 = block (stderr is shown to Claude).
# Defence in depth only: the real protection is that the build environment holds NO production
# vendor credentials and NO production database URL.
input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
[ -z "$cmd" ] && exit 0
block() { echo "BLOCKED by guard.sh: $1. Do not try to work around this; if the task truly needs it, mark the task [!] in docs/BACKLOG.md with the reason." >&2; exit 2; }

# Direct calls to vendor production APIs (spec downloads via tools/fetch_specs.sh are allowed)
if printf '%s' "$cmd" | grep -Eq '(api\.fhb\.sk|system\.fhb\.sk|api1\.inout\.bg|test-api\.inout\.bg|myshopify\.com/admin)' \
   && ! printf '%s' "$cmd" | grep -Eq '^(bash )?tools/fetch_specs\.sh'; then
  block "direct calls to warehouse/Shopify production APIs are not allowed from the build environment"
fi
# Destructive git / filesystem
printf '%s' "$cmd" | grep -Eq 'git push.*(--force|-f( |$)|\+)' && block "force push"
printf '%s' "$cmd" | grep -Eq 'git push[^|;&]*\b(main|master)\b' && block "pushing to main/master (only the autopilot branch is pushed, by the runner)"
printf '%s' "$cmd" | grep -Eq 'rm -rf (/|~|\$HOME)( |$)' && block "recursive delete outside the project"
# Production database / deploy
printf '%s' "$cmd" | grep -Eq '(DATABASE_URL_PROD|render\.com/deploy|render deploy|prisma migrate deploy)' && block "production database or deploy actions"
# Secrets dumping
printf '%s' "$cmd" | grep -Eq '(^|[;&| ])(printenv|env)( |$)|cat .*\.env(\.|$| )' && block "printing environment/secrets"
exit 0
