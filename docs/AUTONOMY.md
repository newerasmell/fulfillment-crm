# Running the build unattended (autopilot)

The autopilot works through `docs/BACKLOG.md` task by task without anyone at the desk. Each task goes:
implement → tests → independent audit → fix → commit → push. When a phase is finished it runs a full phase
audit and opens a pull request. It stops and messages you on Telegram when it reaches a **GATE** (something
only you can do), a **blocked** task, failing checks it cannot fix, or the budget limit.

## What runs where

| Piece | File | Job |
|---|---|---|
| Runner loop | `autopilot/run.sh` | Picks the next open task, runs `claude -p` headless, re-checks independently, retries fixes, commits, pushes, audits phases, opens PRs, notifies |
| Stop hook | `.claude/hooks/verify.sh` | Claude cannot finish a run while typecheck/lint/tests fail |
| Guard hook | `.claude/hooks/guard.sh` | Blocks calls to warehouse/Shopify production APIs, pushes to main, force-push, deploys, printing secrets |
| Auditor | `.claude/agents/auditor.md` | Independent read-only reviewer, checks code against CLAUDE.md and the vendor references |
| Prompts | `.claude/prompts/*.md` | Task, fix and phase-audit instructions |
| Container | `autopilot/Dockerfile`, `docker-compose.yml` | Isolated box with Postgres for tests, non-root user |
| Notifications | `autopilot/notify.sh` | Telegram and/or Slack webhook |

## Safety model (production-only project)

1. **The build box never holds production secrets.** No FHB, Joy, euShipments or Shopify credentials and
   no production database URL go into `autopilot.env`. The autopilot builds and tests against fixtures and
   mocks. Real credentials are entered by you in the deployed CRM at the GATEs, where every connection
   starts in READ_ONLY.
2. It works only on the `autopilot` branch. It never merges to `main` and never deploys. You merge the
   phase PRs (from your phone, on GitHub) and Render deploys `main`.
3. `bypassPermissions` mode is used only inside the container (Anthropic's docs recommend it for
   isolated environments only). Deny rules and the guard hook still apply.
4. Hard limits: total budget, per-task budget, max turns, max tasks, stop phase.

## One-time setup (≈30 min)

1. **A machine that stays on.** Cheapest: a small cloud VM (e.g. Hetzner CX22 / any VPS with 4 GB RAM)
   with Docker installed. Your own PC works too if it never sleeps.
2. **GitHub repo**: push this kit to a private repo, `main` branch. Create a fine-grained token with
   *Contents: read/write* and *Pull requests: read/write* for that repo only → `GH_TOKEN`.
3. **Claude auth** for the container, one of:
   - `ANTHROPIC_API_KEY` (pay per use; the budget caps apply directly), or
   - `CLAUDE_CODE_OAUTH_TOKEN` from running `claude setup-token` on your computer (uses your Claude
     subscription; long runs will hit usage limits — the runner sleeps and retries automatically).
4. **Telegram notifications**: create a bot with @BotFather → `TELEGRAM_BOT_TOKEN`; send the bot a
   message, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` to read your `chat.id` →
   `TELEGRAM_CHAT_ID`.
5. On the VM:
   ```bash
   git clone https://github.com/<you>/<repo>.git crm && cd crm
   cp autopilot/autopilot.env.example autopilot/autopilot.env   # fill it in
   docker compose -f autopilot/docker-compose.yml up -d --build
   docker compose -f autopilot/docker-compose.yml logs -f autopilot   # optional, to watch
   ```

## Day-to-day

- You get Telegram messages: started, each phase done + audited (with a PR), paused at GATE, stopped.
- **At a GATE**: do the action described (e.g. create Render services, enter credentials in the CRM,
  run `pnpm fixtures:record`), then mark that GATE line `[x]` in `docs/BACKLOG.md` on the `autopilot`
  branch (GitHub web editor is fine) and restart:
  `docker compose -f autopilot/docker-compose.yml up -d autopilot`
- **When blocked**: the message contains the reason. Answer it by editing `docs/PROGRESS.md` (Decisions)
  and change the task back from `[!]` to `[ ]`, then restart.
- **Stop it any time**: `docker compose -f autopilot/docker-compose.yml stop autopilot`.
- **Where it can go next**: set `STOP_AT_PHASE` in `autopilot.env` (e.g. 4 = stop before stock/inbound
  work so you can test the core flow first).
- Review progress from anywhere: GitHub → branch `autopilot` → `docs/PROGRESS.md`, `docs/audits/`,
  the phase PRs, and the commit list (one commit per task).

## GATEs you will be asked for (from BACKLOG.md)

P0-G1 Render setup + first owner user · P1-G1 Shopify Dev Dashboard app + store credentials ·
P2-G1 FHB/Joy credentials (READ_ONLY) + record fixtures · P3-G1 euShipments token + testMode
confirmation + fixtures · P4-G1 dry-run review → canary → live · P8-G1 Anthropic key for the app's AI.

## After the build: keep it upgrading itself

Once phase 9 is live, the deployed CRM detects vendor API changes daily and writes an "upgrade brief".
To let the autopilot implement those unattended too:
1. Add a cron line on the VM (daily 06:00):
   `0 6 * * * cd ~/crm && git pull && bash tools/fetch_specs.sh && docker compose -f autopilot/docker-compose.yml up -d autopilot`
2. Add a standing task at the end of BACKLOG, e.g.
   `- [ ] P10-01 If docs/integrations/raw changed since the last commit, apply the changes per the
   "Any time a vendor changes something" prompt in docs/PROMPTS.md; otherwise mark done.`
   Re-open it (`[ ]`) after each run, or let the cron script do it with `sed`.
Affected warehouse connections drop to DRY_RUN automatically (P9-02) until you confirm the new payloads,
so an automated upgrade can never silently change what is sent to a warehouse.

## Alternative without a server: Claude Code cloud scheduled tasks

Claude Code can run scheduled tasks on Anthropic's cloud (research preview), which keep running with
your laptop closed. Each run starts from a fresh clone of the repo, the minimum interval is 1 hour, and
they are created at claude.ai/code or with `/schedule`. You could schedule "every hour: do the next open
task in docs/BACKLOG.md following .claude/prompts/task.md, then push to the autopilot branch". It is
simpler to start but slower (one task per hour), and the test database must be available inside the
cloud environment. The VM runner above is the recommended path for a project this size.
