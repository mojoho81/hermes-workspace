# Swarm shared memory — PROJECT.md

What this is: shared project memory for the hermes-workspace swarm on
Muhammad's VPS. Worker startup snapshots reference this file for
orientation. Created 2026-07-13 (librarian).

## Authority

The repo's /root/hermes-workspace/AGENTS.md is the authoritative
operating doc (roster, lanes, rules). This file is orientation only —
if they disagree, AGENTS.md wins.

## Roster (live set, 5 workers)

- orchestrator — routing, mission state, dispatch
- researcher   — investigation and analysis
- ops-watch    — infra checks and monitoring
- librarian    — knowledge bases, docs hygiene, handoffs
- builder      — code changes in hermes-workspace

Retired ad-hoc profiles (km-agent, workspace) are archived under
/root/hermes-runtime/retired-profiles/.

## Where things live

- Handoffs: /root/hermes-workspace/memory/handoffs/swarm/
  (symlink to /root/hermes-runtime/memory-handoffs/swarm/).
  Each worker reads its own <worker>-latest.md on startup;
  orchestrator-latest.md is the canonical current-state note.
- Shared mission notes: /root/hermes-workspace/memory/swarm/missions/
- Runtime state (swarm-missions.json etc.):
  /root/hermes-runtime/runtime/ — writes need Muhammad's greenlight.
