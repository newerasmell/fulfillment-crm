# Fulfillment CRM — starter kit for Claude Code

**Започни от START_HERE.md (на български).**

1. Create an empty folder (or GitHub repo) and unzip this kit into it. `git init` and commit.
2. Open the folder with Claude Code. It reads `CLAUDE.md` automatically.
3. Answer the open items in `docs/SPEC.md` §11 (credentials, which company owns which warehouse
   account, routing by country, store codes). Put answers into `docs/PROGRESS.md` under Decisions.
4. Either run it unattended with the autopilot (`docs/AUTONOMY.md`, recommended) or paste the phase
   prompts from `docs/PROMPTS.md` into Claude Code yourself.
5. We run on production APIs only. Have ready before Phase 2/3: FHB app_id/secret and Joy appId/secret
   (from ZOE) and the euShipments API token. Each connection goes READ_ONLY → DRY_RUN → CANARY → LIVE
   (see `docs/integrations/INTEGRATION_NOTES.md` §6), so nothing real is sent until you allow it.

Contents
- `CLAUDE.md` — rules Claude Code follows in every session
- `docs/SPEC.md` — product + technical spec, data model, workflows, AI design, phases
- `docs/PROMPTS.md` — ready prompts per phase (manual mode)
- `docs/BACKLOG.md` — ordered tasks with acceptance criteria and GATEs
- `docs/DESIGN.md` — UI direction and tokens (concept canvas in Claude)
- `docs/AUTONOMY.md` — how to run the build unattended
- `autopilot/` — runner, container, notifier · `.claude/` — permissions, hooks, auditor agent, prompts
- `docs/integrations/INTEGRATION_NOTES.md` — how we use each vendor API, traps, status maps, validators
- `docs/integrations/*.md` — complete vendor API references (rendered), `raw/` — original specs
- `tools/fetch_specs.sh` — re-download vendor specs and re-render references (detects API changes)
