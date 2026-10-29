#!/usr/bin/env bash
# Autopilot: works through docs/BACKLOG.md with Claude Code in headless mode, unattended.
# Stops at GATE lines, at STOP_AT_PHASE, on a blocked task, or when a budget/limit is reached,
# and sends a notification each time. Run inside the autopilot container (see docs/AUTONOMY.md).
set -uo pipefail
cd "$(dirname "$0")/.."

STOP_AT_PHASE=${STOP_AT_PHASE:-9}          # stop before starting tasks of a later phase
MAX_TASKS=${MAX_TASKS:-300}                # safety cap per runner start
TASK_BUDGET_USD=${TASK_BUDGET_USD:-20}     # per claude -p run (--max-budget-usd)
TOTAL_BUDGET_USD=${TOTAL_BUDGET_USD:-400}  # stop when spent on this runner start
MAX_TURNS=${MAX_TURNS:-250}
MODEL=${MODEL:-opus}
PERMISSION_MODE=${PERMISSION_MODE:-bypassPermissions}   # only inside the isolated container
BRANCH=${BRANCH:-autopilot}
FIX_ATTEMPTS=${FIX_ATTEMPTS:-2}
LOGDIR=autopilot/logs; mkdir -p "$LOGDIR"
spent=0

notify() { bash autopilot/notify.sh "$1" || true; echo "[notify] $1"; }
add_cost() { local c; c=$(jq -r '.total_cost_usd // 0' "$1" 2>/dev/null || echo 0); spent=$(python3 -c "print(round($spent+$c,2))"); }
over_budget() { python3 -c "import sys; sys.exit(0 if $spent >= $TOTAL_BUDGET_USD else 1)"; }

run_claude() {  # $1 prompt text, $2 log file
  local tries=0
  while :; do
    claude -p "$1" --model "$MODEL" --permission-mode "$PERMISSION_MODE" --max-turns "$MAX_TURNS" \
      --max-budget-usd "$TASK_BUDGET_USD" --output-format json > "$2" 2> "$2.err"
    local rc=$?
    add_cost "$2"
    [ $rc -eq 0 ] && return 0
    tries=$((tries+1))
    if grep -qiE 'rate.?limit|overloaded|529|usage limit' "$2" "$2.err" 2>/dev/null && [ $tries -le 6 ]; then
      notify "Autopilot: rate/usage limit hit, sleeping 20 min (try $tries)"; sleep 1200; continue
    fi
    return $rc
  done
}

checks() { [ -f package.json ] || return 0; { pnpm -s typecheck && pnpm -s lint && pnpm -s test; } > "$LOGDIR/checks.log" 2>&1; }

push() { git push -u origin "$BRANCH" >/dev/null 2>&1 || notify "Autopilot: git push failed (check GH_TOKEN)"; }

open_phase_pr() {  # $1 phase
  command -v gh >/dev/null || return 0
  gh pr create --base main --head "$BRANCH" --title "Autopilot: up to phase $1" \
    --body "Automated build through phase $1. See docs/PROGRESS.md and docs/audits/phase-$1.md." >/dev/null 2>&1 || true
}

git checkout -B "$BRANCH" >/dev/null 2>&1 || git checkout "$BRANCH"
notify "Autopilot started on branch $BRANCH (stop at phase $STOP_AT_PHASE, budget \$$TOTAL_BUDGET_USD)"
prev_phase=""; done_count=0

while :; do
  line=$(grep -nE '^- \[ \] ' docs/BACKLOG.md | head -n1)
  if [ -z "$line" ]; then notify "Autopilot: backlog finished ✅ (spent \$$spent)"; break; fi
  lineno=${line%%:*}; text=${line#*:}
  if printf '%s' "$text" | grep -q 'GATE'; then
    notify "Autopilot paused at a GATE — needs you: $(printf '%s' "$text" | sed 's/^- \[ \] //') (spent \$$spent)"; break
  fi
  id=$(printf '%s' "$text" | grep -oE 'P[0-9]+-[0-9]+[a-z]?' | head -n1)
  phase=$(printf '%s' "$id" | sed -E 's/^P([0-9]+)-.*/\1/')
  # audit every finished phase that has no audit report yet (also after restarts at a GATE)
  for fp in $(grep -oE '^- \[x\] P[0-9]+-' docs/BACKLOG.md | grep -oE '[0-9]+' | sort -un); do
    [ "$fp" -ge "$phase" ] && continue
    [ -f "docs/audits/phase-$fp.md" ] && continue
    base=$(git log --reverse --format=%H --grep="^P$fp-" | head -n1)
    base=${base:+$base^}; base=${base:-$(git rev-list --max-parents=0 HEAD)}
    p=$(sed "s/__PHASE__/$fp/g; s/__BASE__/$base/g" .claude/prompts/phase-audit.md)
    run_claude "$p" "$LOGDIR/phase-$fp-audit.json"
    [ -n "$(git status --porcelain)" ] && git add -A && git commit -qm "Phase $fp audit" || true
    checks || notify "Autopilot: checks failing after phase $fp audit — see $LOGDIR/checks.log"
    push; open_phase_pr "$fp"
    notify "Autopilot: phase $fp done and audited (spent \$$spent)"
  done
  prev_phase=$phase
  if [ "$phase" -gt "$STOP_AT_PHASE" ]; then notify "Autopilot reached STOP_AT_PHASE=$STOP_AT_PHASE"; break; fi
  if [ "$done_count" -ge "$MAX_TASKS" ]; then notify "Autopilot: MAX_TASKS reached"; break; fi
  if over_budget; then notify "Autopilot: total budget \$$TOTAL_BUDGET_USD reached"; break; fi

  prompt=$(python3 - "$id" "$text" <<'PY'
import sys; t=open(".claude/prompts/task.md").read()
print(t.replace("__TASK_ID__",sys.argv[1]).replace("__TASK_LINE__",sys.argv[2]))
PY
)
  echo "=== $(date -Is) $id"
  run_claude "$prompt" "$LOGDIR/$id.json" || notify "Autopilot: claude run for $id ended with an error (see logs)"

  ok=0
  for i in $(seq 0 "$FIX_ATTEMPTS"); do
    if checks; then ok=1; break; fi
    [ "$i" -eq "$FIX_ATTEMPTS" ] && break
    fail=$(tail -n 80 "$LOGDIR/checks.log")
    fp=$(python3 - "$id" "$fail" <<'PY'
import sys; t=open(".claude/prompts/fix.md").read()
print(t.replace("__TASK_ID__",sys.argv[1]).replace("__FAIL_LOG__",sys.argv[2]))
PY
)
    run_claude "$fp" "$LOGDIR/$id-fix$i.json"
  done
  [ -n "$(git status --porcelain)" ] && git add -A && git commit -qm "$id: autopilot WIP" || true

  if grep -nE "^- \[!\] .*$id" docs/BACKLOG.md >/dev/null; then
    push; notify "Autopilot STOPPED: $id blocked — $(sed -n "$((lineno+1))p" docs/BACKLOG.md | sed 's/^ *//')"; break
  fi
  if [ $ok -ne 1 ]; then
    push; notify "Autopilot STOPPED: checks still failing after $id — see $LOGDIR/checks.log"; break
  fi
  if grep -nE "^- \[ \] .*$id( |$)" docs/BACKLOG.md >/dev/null && ! grep -qE "^- \[ \] ${id}[a-z] " docs/BACKLOG.md; then
    notify "Autopilot STOPPED: $id not marked done and not split — needs a look"; push; break
  fi
  push; done_count=$((done_count+1))
done
echo "Total spent: \$$spent"
