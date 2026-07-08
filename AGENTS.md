# Hermes Workspace Agent Contract

This workspace uses semantic Hermes swarm workers, not numbered-only lanes. The source of truth for routing is `swarm.yaml`; each worker has a matching profile under `~/.hermes/profiles/<worker-id>/` and a wrapper in `~/.local/bin/<worker-id>`.

## Current semantic roster (Muhammad's VPS — actual, 2026-07-06)

Upstream's 10-worker example roster is preserved in `swarm.yaml.upstream-example` for reference. It is NOT this install's roster — do not dispatch to workers from that table (builder:task-style wrappers, km-agent, reviewer, qa, maintainer, strategist, inbox-triage do not exist here).

| Worker | Wrapper | Role | Tools | Key skills |
|---|---|---|---|---|
| `orchestrator` | `orchestrator` | Mission routing / decomposition / greenlight gate | todo, kanban, delegation, terminal, file, session_search, cronjob, skills, clarify, web | working-with-muhammad, kanban-orchestrator, subagent-driven-development, plan |
| `researcher` | `researcher` | Research / OSINT (archived+cached) / synthesis | web, browser, terminal, file, vision, session_search, skills, todo | working-with-muhammad, osint-archive-research, people-investigation, arxiv |
| `ops-watch` | `ops-watch` | VPS infra / runtime health | terminal, cronjob, file, skills, session_search, web | working-with-muhammad, hermes-agent, systematic-debugging, hermes-doctor-triage |
| `librarian` | `librarian` | Knowledge steward (Obsidian vault + llm-wiki) | file, terminal, session_search, skills, todo, web | working-with-muhammad, obsidian, llm-wiki |
| `builder` | `builder` | Implementation / code + tooling executor | terminal, file, web, browser, session_search, skills, todo | working-with-muhammad, test-driven-development, systematic-debugging, requesting-code-review |

## Operating rules

- Keep `swarm.yaml`, profile `config.yaml`, profile SOUL.md, and wrappers aligned when changing a worker.
- Orchestrator routes and enforces greenlight; Builder implements; Researcher researches; Ops-watch monitors; Librarian curates knowledge.
- Git discipline in this repo: production branch is `vps-prod` (local commits on top of upstream `main`). NEVER `git pull`/`reset`/`checkout main` without checking local commits first. Upstream merges are deliberate rebases onto `vps-prod`. Safety nets (2026-07-08): `pull.ff=only`, `remote.pushDefault=fork`, a `pre-rebase` hook snapshots `backup/vps-prod-<ts>` before any rebase, and `vps-prod` is pushed to the fork (mojoho81/hermes-workspace) — push after every local commit.
- Runtime state is NOT in the repo (2026-07-08): `.runtime` and `memory/handoffs` are symlinks into `/root/hermes-runtime/` (covered by nightly backups). `git clean -fdx` no longer destroys live swarm state, but never delete the symlinks themselves.
- The running service is systemd `hermes-workspace.service` (127.0.0.1:3300, tailscale serve :3443). `dist/BUILD_COMMIT` records which commit the deployed build came from.
- Mac vs VPS: Mac is source+render authority for SEHA/UMF/personal canonical files. VPS workers never modify those. VPS-granted exceptions: /root/Obsidian-Vault, /root/llm-wiki.
- Do not enable optional Hermes plugins globally unless the task explicitly needs them; record plugin/toolset alignment in `swarm.yaml` first.
- Greenlight required (all workers): merge, publish, destructive ops, external sends, credential changes, new dependencies.

## Windows-specific notes (2026-06-01)

- **Three services required**: Gateway (:8642) + Dashboard (:9119) + Workspace (:3000). All must be running for full functionality.
  - Gateway: `hermes gateway run`
  - Dashboard: `hermes dashboard --port 9119 --host 127.0.0.1 --no-open`
  - Workspace: `pnpm dev`
  - Or use the Electron desktop app: `pnpm electron:dev` (auto-starts all three)
- **Desktop app**: Full Electron app (`electron/main.cjs`). Double-click to launch — no terminal needed. Auto-detects and spawns gateway (or dashboard if configured).
- **Build**: `electron:build:win` produces NSIS installer in `release/`.
- **Dev mode**: `electron:dev` launches Electron in dev mode (builds Vite client first, hot-reloads on change).
- **Running build output**: `release/win-unpacked/hermes-workspace.exe` (test builds).
- **Electron:dev fix**: `NODE_ENV=development` prefix doesn't work on Windows — script stripped to just `electron .`.
- **Windows spawn fixes** (in `electron/main.cjs`): `spawnDetached()` uses `cmd /c` on Windows (not `bash -lc`), log paths use `%TEMP%` (not `/tmp`), `isHermesInstalled()` uses `where hermes`, `installHermesInBackground()` uses `pip install` (not `curl|bash`).
- **Two `.env` files**: Gateway reads `C:\\Users\\<you>\\AppData\\Local\\hermes\\.env`; CLI reads `C:\\Users\\<you>\\.hermes\\.env`; workspace reads `hermes-workspace\\.env`. Keep API keys in sync across all three.
- **Gateway API server**: Requires `API_SERVER_ENABLED=true` + `API_SERVER_KEY` in the gateway's `.env`. Without these, the gateway starts with no connected platforms.
- **Workspace env vars**: Runtime reads `CLAUDE_API_URL` / `CLAUDE_API_TOKEN` / `CLAUDE_DASHBOARD_URL` (not `HERMES_*` variants).
- **sqlite3 CLI**: Not bundled on Windows. Install via `winget install SQLite.SQLite`, then copy `sqlite3.exe` to a Git Bash PATH directory (winget installs to a long path not in PATH).
- **claude CLI**: Required for Claude Tasks / Conductor features. Install via `npm install -g @anthropic-ai/claude-code`.
- **Port conflicts**: Use `netstat -ano | findstr :<port>` + `Stop-Process -Id <PID> -Force` (PowerShell) — `lsof` not available in Git Bash on Windows.
- **PWA install**: Dashboard at `http://127.0.0.1:3000` can be installed as PWA via Chrome/Edge address bar install icon. Prefer Electron build for production.
- **Slack invalid_auth**: Expected if Slack tokens aren't configured — ignore, doesn't affect core functionality.
- **Node version**: Requires Node.js 22+. Check with `node --version`.
- **`NODE_OPTIONS` stripped**: Windows doesn't support env var prefix in npm scripts — removed from `build` and `electron:dev` scripts.
