#!/usr/bin/env bash
# Stop hook: Claude may only stop when typecheck, lint and tests pass.
# Exit 2 + stderr = Claude keeps working with the failure output. Capped per session to avoid endless loops.
input=$(cat)
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
[ -f package.json ] || exit 0
sid=$(printf '%s' "$input" | jq -r '.session_id // "nosession"')
mkdir -p .claude/.state; cnt_file=".claude/.state/stop-$sid"
cnt=$(cat "$cnt_file" 2>/dev/null || echo 0)
if [ "$cnt" -ge "${VERIFY_MAX_BLOCKS:-4}" ]; then
  echo "verify.sh: block limit reached for this session; letting it stop (the runner will re-check)." >&2
  exit 0
fi
out=$( { pnpm -s typecheck && pnpm -s lint && pnpm -s test; } 2>&1 )
if [ $? -ne 0 ]; then
  echo $((cnt+1)) > "$cnt_file"
  echo "Checks are failing. Fix them before finishing (attempt $((cnt+1))/${VERIFY_MAX_BLOCKS:-4}). Last output:" >&2
  printf '%s\n' "$out" | tail -n 80 >&2
  exit 2
fi
exit 0
