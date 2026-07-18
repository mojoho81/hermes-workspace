#!/usr/bin/env bash
# deploy.sh — idempotent bootstrap/deploy for hermes-workspace on the VPS.
#
# Usage:
#   scripts/deploy.sh --dry-run    # print what would happen, change nothing
#   scripts/deploy.sh              # full bootstrap + build + restart + verify
#   scripts/deploy.sh --no-restart # activate only if the service is already inactive
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
STAGE_DIR="$REPO_ROOT/.dist-stage.$$"
PREVIOUS_DIST="$REPO_ROOT/.dist-previous.$$"
BUILD_SOURCE_DIR="$REPO_ROOT/.build-source.$$"
ACTIVATION_IN_PROGRESS=0
SERVICE_WAS_ACTIVE=0
HAD_PREVIOUS_DIST=0

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  if [ "$ACTIVATION_IN_PROGRESS" -eq 1 ]; then
    warn "deployment interrupted; restoring previous build"
    systemctl stop "$SERVICE" 2>/dev/null || true
    if [ -e "$PREVIOUS_DIST" ]; then
      rm -rf "$REPO_ROOT/dist"
      mv "$PREVIOUS_DIST" "$REPO_ROOT/dist"
    elif [ "$HAD_PREVIOUS_DIST" -eq 0 ] && [ ! -e "$STAGE_DIR" ]; then
      # No prior release existed and the staged release was already moved.
      rm -rf "$REPO_ROOT/dist"
    fi
    if [ "$SERVICE_WAS_ACTIVE" -eq 1 ] && [ -e "$REPO_ROOT/dist" ]; then
      systemctl start "$SERVICE" 2>/dev/null || true
    fi
  fi
  rm -rf "$STAGE_DIR" "$BUILD_SOURCE_DIR"
  [ "$ACTIVATION_IN_PROGRESS" -eq 1 ] || rm -rf "$PREVIOUS_DIST"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

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
for tool in node pnpm git systemctl curl tar; do
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
if [ "$DRY_RUN" -eq 0 ]; then
  rm -rf "$STAGE_DIR" "$PREVIOUS_DIST" "$BUILD_SOURCE_DIR"
  BUILD_COMMIT="$(git rev-parse HEAD)"
  if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
    fail "refusing deployment from a dirty working tree"
    exit 1
  fi
  # Build from an immutable archive of BUILD_COMMIT, not the live worktree.
  # A pre/post cleanliness check alone cannot detect a source mutation that is
  # restored before the build exits but was already consumed by Vite.
  mkdir -p "$BUILD_SOURCE_DIR"
  git archive "$BUILD_COMMIT" | tar -x -C "$BUILD_SOURCE_DIR"
  cp "$REPO_ROOT/.env" "$BUILD_SOURCE_DIR/.env"
  ln -s "$REPO_ROOT/node_modules" "$BUILD_SOURCE_DIR/node_modules"
  (
    cd "$BUILD_SOURCE_DIR"
    pnpm exec vite build --outDir "$STAGE_DIR"
  )
  [ -f "$STAGE_DIR/server/server.js" ] || { fail "staged build output server/server.js missing"; exit 1; }
  if [ "$(git rev-parse HEAD)" != "$BUILD_COMMIT" ] \
     || [ -n "$(git status --porcelain --untracked-files=normal -- . \
       ":(exclude).build-source.$$/**" \
       ":(exclude).dist-stage.$$/**" \
       ":(exclude).dist-previous.$$/**")" ]; then
    fail "source tree changed during build; refusing an unbound artifact"
    exit 1
  fi
  printf '%s\n' "$BUILD_COMMIT" > "$STAGE_DIR/BUILD_COMMIT"
  rm -rf "$BUILD_SOURCE_DIR"
  ok "staged immutable build; BUILD_COMMIT=$(cat "$STAGE_DIR/BUILD_COMMIT")"
else
  say "DRY  would archive HEAD into $BUILD_SOURCE_DIR and build it into $STAGE_DIR"
  say "DRY  would write $STAGE_DIR/BUILD_COMMIT=$(git rev-parse HEAD)"
fi

say "== 5/8 systemd unit"
if systemctl list-unit-files "$SERVICE" --no-legend 2>/dev/null | grep -q "$SERVICE"; then
  ok "$SERVICE installed"
  systemctl is-enabled --quiet "$SERVICE" && ok "$SERVICE enabled" || warn "$SERVICE not enabled (systemctl enable $SERVICE)"
else
  fail "$SERVICE not installed — install the unit file, then re-run"
fi
[ "$FAILURES" -eq 0 ] || { say "aborting before activation: systemd unit unavailable"; exit 1; }

healthcheck_workspace() {
  for i in $(seq 1 30); do
    if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:3300/"; then return 0; fi
    sleep 1
  done
  return 1
}

current_service_state() {
  local state rc
  set +e
  state="$(systemctl is-active "$SERVICE" 2>/dev/null)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ] && [ "$state" = "active" ]; then
    printf 'active\n'
    return 0
  fi
  if [ "$rc" -eq 3 ] && [ "$state" = "inactive" ]; then
    printf 'inactive\n'
    return 0
  fi
  return 1
}

check_workspace_capabilities() {
  local status_json
  status_json="$(curl -fsS --max-time 10 "http://127.0.0.1:3300/api/connection-status" 2>/dev/null || true)"
  [ -n "$status_json" ] || return 1
  STATUS_JSON="$status_json" node -e '
    const s = JSON.parse(process.env.STATUS_JSON)
    const required = ["sessions", "skills", "memory", "config", "jobs"]
    const missing = required.filter((name) => s.capabilities?.[name] !== true)
    if (s.status !== "enhanced" || missing.length) {
      console.error(`status=${s.status ?? "unknown"}; missing=${missing.join(",") || "none"}`)
      process.exit(1)
    }
  '
}

check_port() {
  local port="$1" name="$2" required="$3"
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$port/" 2>/dev/null \
     || ss -tln 2>/dev/null | grep -q "127.0.0.1:$port "; then
    ok "$name listening on 127.0.0.1:$port"
    return 0
  fi
  if [ "$required" = "required" ]; then
    fail "$name NOT listening on 127.0.0.1:$port"
    return 1
  fi
  warn "$name not listening on 127.0.0.1:$port (separate service — check hermes gateway/dashboard)"
  return 0
}

rollback_build() {
  warn "new build failed acceptance; rolling back"
  systemctl stop "$SERVICE" 2>/dev/null || true
  rm -rf "$REPO_ROOT/dist"
  if [ -e "$PREVIOUS_DIST" ]; then
    mv "$PREVIOUS_DIST" "$REPO_ROOT/dist"
    if systemctl start "$SERVICE" && healthcheck_workspace; then
      ok "rollback restored previous build and service health"
    else
      fail "rollback could not restore service health"
    fi
  else
    fail "no previous dist available for rollback"
  fi
  ACTIVATION_IN_PROGRESS=0
  return 1
}

accept_new_build() {
  local state
  if ! systemctl start "$SERVICE"; then
    fail "could not start $SERVICE on the staged build"
    return 1
  fi
  if ! healthcheck_workspace; then
    fail "workspace :3300 not answering 30s after restart"
    return 1
  fi
  if ! state="$(current_service_state)"; then
    fail "could not establish $SERVICE state after restart"
    return 1
  fi
  if [ "$state" != "active" ]; then
    fail "$SERVICE not active after restart"
    return 1
  fi
  if ! check_workspace_capabilities; then
    fail "Workspace enhanced capability check failed"
    return 1
  fi
  if ! check_port 3300 "workspace" required; then
    return 1
  fi
  # A final exact state probe prevents an exited service from skipping the
  # remaining acceptance gates as if it were intentionally inactive.
  if ! state="$(current_service_state)"; then
    fail "could not establish $SERVICE state at acceptance commit"
    return 1
  fi
  if [ "$state" != "active" ]; then
    fail "$SERVICE became inactive before acceptance commit"
    return 1
  fi
}

say "== 6/8 atomic activation + restart + health"
if [ "$DRY_RUN" -eq 1 ]; then
  say "DRY  would stop $SERVICE, atomically swap staged dist, start, health-check, and roll back on failure"
else
  SERVICE_WAS_ACTIVE=0
  if ! SERVICE_STATE="$(current_service_state)"; then
    fail "could not establish $SERVICE state; refusing activation"
    exit 1
  fi
  [ "$SERVICE_STATE" = "active" ] && SERVICE_WAS_ACTIVE=1
  if [ "$NO_RESTART" -eq 1 ] && [ "$SERVICE_WAS_ACTIVE" -eq 1 ]; then
    fail "refusing --no-restart while $SERVICE is active; activation would invalidate its hashed modules"
    exit 1
  fi

  HAD_PREVIOUS_DIST=0
  [ -e "$REPO_ROOT/dist" ] && HAD_PREVIOUS_DIST=1
  ACTIVATION_IN_PROGRESS=1
  if [ "$SERVICE_WAS_ACTIVE" -eq 1 ]; then
    systemctl stop "$SERVICE"
  fi
  if [ -e "$REPO_ROOT/dist" ]; then
    mv "$REPO_ROOT/dist" "$PREVIOUS_DIST"
  fi
  if ! mv "$STAGE_DIR" "$REPO_ROOT/dist"; then
    fail "could not activate staged build"
    rollback_build || true
    exit 1
  fi

  if [ "$NO_RESTART" -eq 1 ]; then
    ACTIVATION_IN_PROGRESS=0
    rm -rf "$PREVIOUS_DIST"
    ok "staged build activated while service remains inactive (--no-restart)"
  elif ! accept_new_build; then
    rollback_build || true
    fail "staged build failed required acceptance; previous build restored where possible"
    exit 1
  else
    ACTIVATION_IN_PROGRESS=0
    rm -rf "$PREVIOUS_DIST"
    ok "$SERVICE active with enhanced capabilities and required port on the staged build"
  fi
fi
# The required workspace port was checked before the activation commit above.
# Gateway/dashboard are separate services, so their absence remains advisory.
if [ "$DRY_RUN" -eq 0 ] && [ "$NO_RESTART" -eq 0 ]; then
  check_port 8642 "hermes gateway" optional
  check_port 9119 "hermes dashboard" optional
elif [ "$DRY_RUN" -eq 0 ]; then
  warn "runtime port checks skipped because --no-restart leaves $SERVICE inactive"
fi

say "== 7/8 Workspace runtime capabilities"
if [ "$DRY_RUN" -eq 1 ]; then
  say "DRY  would require enhanced status with sessions, skills, memory, config, and jobs"
elif [ "$NO_RESTART" -eq 1 ]; then
  warn "runtime capability check skipped because --no-restart leaves the service inactive"
else
  ok "Workspace enhanced capabilities verified before activation commit"
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
