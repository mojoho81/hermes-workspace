import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const created: Array<string> = []
const source = join(process.cwd(), 'scripts', 'deploy.sh')

type InterruptWindow = 'before-old-move' | 'after-old-move'
type ServiceProbe = 'normal' | 'error' | 'inactive-after-acceptance'

type FixtureOptions = {
  capabilityFailure?: boolean
  interruptAt?: InterruptWindow
  noRestart?: boolean
  persistentMutation?: boolean
  portFailure?: boolean
  reportBuildTempsInStatus?: boolean
  serviceProbe?: ServiceProbe
  transientMutation?: boolean
}

function executable(path: string, text: string) {
  writeFileSync(path, text)
  chmodSync(path, 0o755)
}

function fixture(options: FixtureOptions = {}) {
  const base = mkdtempSync(join(tmpdir(), 'workspace-deploy-atomic-'))
  created.push(base)
  const repo = join(base, 'repo')
  const scripts = join(repo, 'scripts')
  const runtime = join(base, 'runtime-root')
  const snapshot = join(base, 'committed-source')
  const bin = join(base, 'bin')
  mkdirSync(scripts, { recursive: true })
  mkdirSync(join(runtime, 'runtime'), { recursive: true })
  mkdirSync(join(runtime, 'memory-handoffs'), { recursive: true })
  mkdirSync(join(repo, 'node_modules'), { recursive: true })
  mkdirSync(snapshot)
  mkdirSync(bin)
  symlinkSync(join(runtime, 'runtime'), join(repo, '.runtime'))
  mkdirSync(join(repo, 'memory'))
  symlinkSync(join(runtime, 'memory-handoffs'), join(repo, 'memory', 'handoffs'))
  writeFileSync(join(repo, '.env'), 'TEST=1\n')
  writeFileSync(join(repo, 'source.txt'), 'stable-source\n')
  writeFileSync(join(snapshot, 'source.txt'), 'stable-source\n')
  mkdirSync(join(repo, 'dist', 'server'), { recursive: true })
  writeFileSync(join(repo, 'dist', 'server', 'server.js'), 'old-build\n')
  writeFileSync(join(repo, 'dist', 'BUILD_COMMIT'), 'old-commit\n')
  const serviceState = join(base, 'service-state')
  const serviceProbeCount = join(base, 'service-probe-count')
  const gitStatusCount = join(base, 'git-status-count')
  const rootCurlCount = join(base, 'root-curl-count')
  writeFileSync(serviceState, 'active\n')
  writeFileSync(serviceProbeCount, '0\n')
  writeFileSync(gitStatusCount, '0\n')
  writeFileSync(rootCurlCount, '0\n')

  let deployText = readFileSync(source, 'utf8').replace(
    'RUNTIME_ROOT="/root/hermes-runtime"',
    `RUNTIME_ROOT="${runtime}"`,
  )
  if (options.interruptAt === 'before-old-move') {
    const needle = '  ACTIVATION_IN_PROGRESS=1\n'
    expect(deployText.split(needle)).toHaveLength(2)
    deployText = deployText.replace(needle, `${needle}  kill -TERM $$\n`)
  }
  if (options.interruptAt === 'after-old-move') {
    const needle = '    mv "$REPO_ROOT/dist" "$PREVIOUS_DIST"\n'
    expect(deployText.split(needle)).toHaveLength(2)
    deployText = deployText.replace(needle, `${needle}    kill -TERM $$\n`)
  }
  const deploy = join(scripts, 'deploy.sh')
  executable(deploy, deployText)

  executable(
    join(bin, 'node'),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo v22.0.0; exit 0; fi
if [ "$1" = "-e" ] && [ -n "\${STATUS_JSON:-}" ]; then exit ${options.capabilityFailure ? 1 : 0}; fi
exit 0
`,
  )
  executable(
    join(bin, 'pnpm'),
    `#!/bin/sh
if [ "$1" = "install" ]; then exit 0; fi
out=""
for arg in "$@"; do out="$arg"; done
${options.transientMutation ? `printf 'transient-source\\n' > '${join(repo, 'source.txt')}'` : ''}
mkdir -p "$out/server"
cp "$PWD/source.txt" "$out/server/server.js"
${options.transientMutation ? `printf 'stable-source\\n' > '${join(repo, 'source.txt')}'` : ''}
exit 0
`,
  )
  executable(
    join(bin, 'git'),
    `#!/bin/sh
if [ "$1" = "rev-parse" ]; then printf 'deadbeef\\n'; exit 0; fi
if [ "$1" = "status" ]; then
  count=$(cat '${gitStatusCount}')
  count=$((count + 1))
  printf '%s\\n' "$count" > '${gitStatusCount}'
  if [ '${options.persistentMutation ? 'yes' : 'no'}' = yes ] && [ "$count" -ge 2 ]; then
    printf '?? stray-during-build.txt\\n'
  fi
  exclude_owned=0
  for arg in "$@"; do
    case "$arg" in *':(exclude).build-source.'*|*':(exclude).dist-stage.'*|*':(exclude).dist-previous.'*) exclude_owned=1 ;; esac
  done
  if [ '${options.reportBuildTempsInStatus ? 'yes' : 'no'}' = yes ] && [ "$exclude_owned" -eq 0 ]; then
    for path in '${repo}'/.build-source.* '${repo}'/.dist-stage.* '${repo}'/.dist-previous.*; do
      [ -e "$path" ] && printf '?? %s/\\n' "$(basename "$path")"
    done
  fi
  exit 0
fi
if [ "$1" = "diff" ]; then exit 0; fi
if [ "$1" = "archive" ]; then exec /usr/bin/tar -cf - -C '${snapshot}' .; fi
if [ "$1" = "remote" ] && [ "$2" = "get-url" ]; then exit 1; fi
exit 1
`,
  )
  executable(
    join(bin, 'systemctl'),
    `#!/bin/sh
state="${serviceState}"
count_file="${serviceProbeCount}"
case "$1" in
  list-unit-files) printf 'hermes-workspace.service enabled\\n'; exit 0 ;;
  is-enabled) exit 0 ;;
  is-active)
    count=$(cat "$count_file")
    count=$((count + 1))
    printf '%s\\n' "$count" > "$count_file"
    if [ '${options.serviceProbe ?? 'normal'}' = error ]; then printf 'unknown\\n'; exit 4; fi
    if [ '${options.serviceProbe ?? 'normal'}' = inactive-after-acceptance ] && [ "$count" -ge 3 ]; then
      printf 'inactive\\n' > "$state"
    fi
    current=$(cat "$state")
    printf '%s\\n' "$current"
    [ "$current" = active ] && exit 0 || exit 3 ;;
  stop) printf 'inactive\\n' > "$state"; exit 0 ;;
  start) printf 'active\\n' > "$state"; exit 0 ;;
esac
exit 1
`,
  )
  executable(
    join(bin, 'curl'),
    `#!/bin/sh
url=""
for arg in "$@"; do url="$arg"; done
case "$url" in
  *connection-status*) printf '%s\\n' '{"status":"enhanced","capabilities":{"sessions":true,"skills":true,"memory":true,"config":true,"jobs":true}}'; exit 0 ;;
  http://127.0.0.1:3300/)
    count=$(cat '${rootCurlCount}')
    count=$((count + 1))
    printf '%s\\n' "$count" > '${rootCurlCount}'
    if [ '${options.portFailure ? 'yes' : 'no'}' = yes ] && [ "$count" -eq 2 ]; then exit 1; fi
    exit 0 ;;
esac
exit 0
`,
  )
  executable(join(bin, 'ss'), '#!/bin/sh\nexit 1\n')

  const result = spawnSync(deploy, options.noRestart ? ['--no-restart'] : [], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
  })
  return { base, repo, result, serviceState }
}

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true })
})

function transientDirs(repo: string) {
  return readdirSync(repo).filter(
    (name) =>
      name.startsWith('.dist-stage.') ||
      name.startsWith('.dist-previous.') ||
      name.startsWith('.build-source.'),
  )
}

function expectOldBuildRestored(repo: string, serviceState: string) {
  expect(existsSync(join(repo, 'dist'))).toBe(true)
  expect(readFileSync(join(repo, 'dist', 'server', 'server.js'), 'utf8')).toBe(
    'old-build\n',
  )
  expect(readFileSync(serviceState, 'utf8')).toBe('active\n')
  expect(transientDirs(repo)).toEqual([])
}

describe('atomic Workspace deployment', () => {
  it('rolls back when enhanced capabilities fail after root health', () => {
    const { repo, result, serviceState } = fixture({ capabilityFailure: true })
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('enhanced capability check failed')
    expectOldBuildRestored(repo, serviceState)
  })

  it('preserves the old build when interrupted before the old dist move', () => {
    const { repo, result, serviceState } = fixture({
      interruptAt: 'before-old-move',
    })
    expect(result.status).not.toBe(0)
    expectOldBuildRestored(repo, serviceState)
  })

  it('restores the old build when interrupted after the old dist move', () => {
    const { repo, result, serviceState } = fixture({
      interruptAt: 'after-old-move',
    })
    expect(result.status).not.toBe(0)
    expectOldBuildRestored(repo, serviceState)
  })

  it('fails closed on an is-active error even with --no-restart', () => {
    const { repo, result, serviceState } = fixture({
      noRestart: true,
      serviceProbe: 'error',
    })
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('could not establish')
    expectOldBuildRestored(repo, serviceState)
  })

  it('builds from the immutable commit snapshot despite restored transient source mutation', () => {
    const { repo, result } = fixture({ transientMutation: true })
    expect(result.status).toBe(0)
    expect(readFileSync(join(repo, 'source.txt'), 'utf8')).toBe('stable-source\n')
    expect(readFileSync(join(repo, 'dist', 'server', 'server.js'), 'utf8')).toBe(
      'stable-source\n',
    )
    expect(transientDirs(repo)).toEqual([])
  })

  it('rolls back when the required workspace port fails after initial health', () => {
    const { repo, result, serviceState } = fixture({ portFailure: true })
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('workspace NOT listening')
    expectOldBuildRestored(repo, serviceState)
  })

  it('rolls back when the service becomes inactive before acceptance commits', () => {
    const { repo, result, serviceState } = fixture({
      serviceProbe: 'inactive-after-acceptance',
    })
    expect(result.status).not.toBe(0)
    expectOldBuildRestored(repo, serviceState)
  })

  it('excludes only deployment-owned temp directories from the source-integrity status check', () => {
    const { repo, result } = fixture({ reportBuildTempsInStatus: true })
    expect(result.status).toBe(0)
    expect(readFileSync(join(repo, 'dist', 'server', 'server.js'), 'utf8')).toBe(
      'stable-source\n',
    )
    expect(transientDirs(repo)).toEqual([])
  })

  it('refuses activation when an unowned file appears during the build', () => {
    const { repo, result } = fixture({ persistentMutation: true })
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('source tree changed during build')
    expect(readFileSync(join(repo, 'dist', 'server', 'server.js'), 'utf8')).toBe(
      'old-build\n',
    )
    expect(transientDirs(repo)).toEqual([])
  })
})
