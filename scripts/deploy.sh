#!/usr/bin/env bash
# deploy.sh — idempotent bootstrap/deploy for hermes-workspace on the VPS.
#
# Usage:
#   scripts/deploy.sh --dry-run    # print what would happen, change nothing
#   scripts/deploy.sh              # full bootstrap + build + restart + verify
#   scripts/deploy.sh --no-restart # everything except systemd restart
#
# Disaster-recovery / fresh-VPS restore:
#   1. Restore /root/hermes-runtime from the encrypted off-site backup
#      (see vps-backup-ops; /root/hermes-runtime is deliberately NOT in git).
#   2. git clone git@github.com:mojoho81/hermes-workspace && git checkout vps-prod
#   3. Restore .env (from backup) into the repo root.
#   4. Install the systemd unit (docs/ or backup), systemctl enable.
#   5. Run scripts/deploy.sh — it validates tools, relinks runtime state,
#      installs locked deps, builds, restarts, and health-checks.
#
# Safety: refuses to replace real directories/files with symlinks. If
# .runtime or memory/handoffs exist as real dirs (pre-relocation layout or a
# botched restore), it stops and tells you to reconcile manually.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_ROOT="/root/hermes-runtime"
SERVICE="hermes-workspace.service"
FORK_REMOTE="fork"
BRANCH="vps-prod"
NODE_MIN_MAJOR=22

DRY_RUN=0
NO_RESTART=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-restart) NO_RESTART=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

FAILURES=0
say()  { printf '%s\n' "$*"; }
ok()   { printf 'OK   %s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; FAILURES=$((FAILURES+1)); }
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    say "DRY  $*"
  else
    "$@"
  fi
}

cd "$REPO_ROOT"

say "== 1/8 tool versions"
for tool in node pnpm git systemctl curl; do
  if command -v "$tool" >/dev/null 2>&1; then
    ok "$tool $(command -v "$tool")"
  else
    fail "$tool not found"
  fi
done
if command -v node >/dev/null 2>&1; then
  major="$(node --version | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "$major" -ge "$NODE_MIN_MAJOR" ]; then
    ok "node $(node --version) (>= $NODE_MIN_MAJOR)"
  else
    fail "node $(node --version) too old, need >= $NODE_MIN_MAJOR"
  fi
fi
[ "$FAILURES" -eq 0 ] || { say "aborting: missing prerequisites"; exit 1; }

say "== 2/8 runtime symlinks (repo -> $RUNTIME_ROOT)"
ensure_link() {
  local link="$1" target="$2"
  if [ -L "$link" ]; then
    local current; current="$(readlink "$link")"
    if [ "$current" = "$target" ]; then
      ok "$link -> $target"
    else
      fail "$link points to $current, expected $target (fix manually)"
    fi
  elif [ -e "$link" ]; then
    fail "$link exists as a REAL file/dir — refusing to replace. Reconcile its contents into $target, remove it, and re-run."
  else
    if [ ! -d "$target" ]; then
      fail "$target missing — restore /root/hermes-runtime from encrypted backup first (vps-backup-ops)"
      return
    fi
    run mkdir -p "$(dirname "$link")"
    run ln -s "$target" "$link"
    ok "created $link -> $target"
  fi
}
ensure_link "$REPO_ROOT/.runtime" "$RUNTIME_ROOT/runtime"
ensure_link "$REPO_ROOT/memory/handoffs" "$RUNTIME_ROOT/memory-handoffs"
[ "$FAILURES" -eq 0 ] || { say "aborting: runtime layout unsafe"; exit 1; }

say "== 3/8 env + locked dependencies"
if [ -f "$REPO_ROOT/.env" ]; then
  ok ".env present"
else
  fail ".env missing — restore from backup before the service can start"
fi
run pnpm install --frozen-lockfile
[ "$DRY_RUN" -eq 1 ] || ok "dependencies installed (frozen lockfile)"

say "== 4/8 production build"
run pnpm build
if [ "$DRY_RUN" -eq 0 ]; then
  [ -f "$REPO_ROOT/dist/server/server.js" ] || { fail "build output dist/server/server.js missing"; exit 1; }
  git rev-parse HEAD > "$REPO_ROOT/dist/BUILD_COMMIT"
  ok "built; BUILD_COMMIT=$(cat "$REPO_ROOT/dist/BUILD_COMMIT")"
else
  say "DRY  would write dist/BUILD_COMMIT=$(git rev-parse HEAD)"
fi

say "== 5/8 systemd unit"
if systemctl list-unit-files "$SERVICE" --no-legend 2>/dev/null | grep -q "$SERVICE"; then
  ok "$SERVICE installed"
  systemctl is-enabled --quiet "$SERVICE" && ok "$SERVICE enabled" || warn "$SERVICE not enabled (systemctl enable $SERVICE)"
else
  fail "$SERVICE not installed — install the unit file, then re-run"
fi

say "== 6/8 restart + health"
if [ "$NO_RESTART" -eq 1 ]; then
  warn "restart skipped (--no-restart)"
elif [ "$DRY_RUN" -eq 1 ]; then
  say "DRY  would systemctl restart $SERVICE and poll 127.0.0.1:3300"
else
  systemctl restart "$SERVICE"
  for i in $(seq 1 30); do
    if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:3300/"; then break; fi
    sleep 1
    [ "$i" -eq 30 ] && { fail "workspace :3300 not answering 30s after restart"; systemctl status "$SERVICE" --no-pager -l | tail -15; }
  done
  systemctl is-active --quiet "$SERVICE" && ok "$SERVICE active" || fail "$SERVICE not active"
fi
# Port checks: workspace is hard-required; gateway/dashboard are separate
# services so their absence is a warning, not a deploy failure.
check_port() {
  local port="$1" name="$2" required="$3"
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$port/" 2>/dev/null \
     || ss -tln 2>/dev/null | grep -q "127.0.0.1:$port "; then
    ok "$name listening on 127.0.0.1:$port"
  elif [ "$required" = "required" ]; then
    fail "$name NOT listening on 127.0.0.1:$port"
  else
    warn "$name not listening on 127.0.0.1:$port (separate service — check hermes gateway/dashboard)"
  fi
}
if [ "$DRY_RUN" -eq 0 ]; then
  check_port 3300 "workspace" required
  check_port 8642 "hermes gateway" optional
  check_port 9119 "hermes dashboard" optional
fi

say "== 7/8 Workspace runtime capabilities"
if [ "$DRY_RUN" -eq 1 ]; then
  say "DRY  would require enhanced status with sessions, skills, memory, config, and jobs"
else
  status_json="$(curl -fsS --max-time 10 "http://127.0.0.1:3300/api/connection-status" 2>/dev/null || true)"
  if [ -z "$status_json" ]; then
    fail "Workspace connection-status endpoint unavailable"
  elif STATUS_JSON="$status_json" node -e '
    const s = JSON.parse(process.env.STATUS_JSON)
    const required = ["sessions", "skills", "memory", "config", "jobs"]
    const missing = required.filter((name) => s.capabilities?.[name] !== true)
    if (s.status !== "enhanced" || missing.length) {
      console.error(`status=${s.status ?? "unknown"}; missing=${missing.join(",") || "none"}`)
      process.exit(1)
    }
  '; then
    ok "Workspace enhanced capabilities: sessions, skills, memory, config, jobs"
  else
    fail "Workspace enhanced capability check failed"
  fi
fi

say "== 8/8 fork remote parity"
if git remote get-url "$FORK_REMOTE" >/dev/null 2>&1; then
  local_head="$(git rev-parse "$BRANCH")"
  fork_head="$(git ls-remote "$FORK_REMOTE" "refs/heads/$BRANCH" 2>/dev/null | cut -f1 || true)"
  if [ -z "$fork_head" ]; then
    warn "fork remote reachable but no $BRANCH ref — push it: git push $FORK_REMOTE $BRANCH"
  elif [ "$local_head" = "$fork_head" ]; then
    ok "fork/$BRANCH matches local HEAD ($local_head)"
  else
    warn "fork/$BRANCH ($fork_head) != local ($local_head) — push after committing: git push $FORK_REMOTE $BRANCH"
  fi
else
  warn "no '$FORK_REMOTE' remote configured — off-box git redundancy missing"
fi

say ""
if [ "$FAILURES" -gt 0 ]; then
  say "DEPLOY: $FAILURES failure(s) — see FAIL lines above"
  exit 1
fi
[ "$DRY_RUN" -eq 1 ] && say "DRY RUN complete — no changes made" || say "DEPLOY: complete"
