/**
 * Roster alignment test — turns chronic manual drift into a test failure.
 *
 * AGENTS.md rule: "Keep swarm.yaml, profile config.yaml, profile SOUL.md,
 * and wrappers aligned when changing a worker." This suite enforces the
 * machine-checkable parts:
 *
 *   1. swarm.yaml parses; worker IDs are unique and non-empty.
 *   2. No obsolete workers from the upstream example roster
 *      (swarm.yaml.upstream-example) leak into the live roster.
 *   3. Each worker has a Hermes profile at ~/.hermes/profiles/<id>/config.yaml
 *      whose model.default matches swarm.yaml's `model`, with a non-empty
 *      provider.
 *   4. Each worker has a wrapper at ~/.local/bin/<id> that is executable and
 *      dispatches to `hermes -p <id>`.
 *   5. No orphans: every profile dir that looks like a swarm worker profile
 *      (has a matching wrapper) is present in swarm.yaml.
 *
 * On machines without the swarm deployed (Windows/Mac dev boxes, CI), the
 * whole suite skips: it only runs when ~/.hermes/profiles contains at least
 * one of the rostered workers.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const repoRoot = dirname(fileURLToPath(import.meta.url))
const swarmYamlPath = join(repoRoot, 'swarm.yaml')
const upstreamExamplePath = join(repoRoot, 'swarm.yaml.upstream-example')
const profilesDir = join(homedir(), '.hermes', 'profiles')
const wrapperDir = join(homedir(), '.local', 'bin')

interface Worker {
  id: string
  model?: string
  profile?: string
  [key: string]: unknown
}

function loadWorkers(path: string): Array<Worker> {
  const doc = parseYaml(readFileSync(path, 'utf8')) as {
    workers?: Array<Worker>
  }
  return doc?.workers ?? []
}

const workers = existsSync(swarmYamlPath) ? loadWorkers(swarmYamlPath) : []

// Deployed = at least one rostered worker has a profile dir on this machine.
const swarmDeployed =
  existsSync(profilesDir) &&
  workers.some((w) => existsSync(join(profilesDir, w.id)))

describe.skipIf(!swarmDeployed)('swarm roster alignment (VPS)', () => {
  it('swarm.yaml parses with unique, non-empty worker ids', () => {
    expect(workers.length).toBeGreaterThan(0)
    const ids = workers.map((w) => w.id)
    for (const id of ids) {
      expect(id, 'worker id must be a non-empty string').toBeTruthy()
    }
    expect(new Set(ids).size, `duplicate worker ids in: ${ids.join(', ')}`).toBe(
      ids.length,
    )
  })

  it('no obsolete upstream-example workers leak into the live roster', () => {
    if (!existsSync(upstreamExamplePath)) return
    const liveIds = new Set(workers.map((w) => w.id))
    const upstreamOnly = loadWorkers(upstreamExamplePath)
      .map((w) => w.id)
      // ids shared with the live roster are fine; only ids that exist SOLELY
      // in the upstream example are obsolete here.
      .filter((id) => !liveIds.has(id))
    for (const id of upstreamOnly) {
      expect(
        existsSync(join(wrapperDir, id)),
        `obsolete upstream-example worker '${id}' has a wrapper in ~/.local/bin — remove it or add the worker to swarm.yaml`,
      ).toBe(false)
    }
  })

  describe.each(workers.map((w) => [w.id, w] as const))(
    'worker %s',
    (id, worker) => {
      const profileConfigPath = join(profilesDir, id, 'config.yaml')
      const wrapperPath = join(wrapperDir, id)

      it('has a profile config', () => {
        expect(
          existsSync(profileConfigPath),
          `missing ${profileConfigPath}`,
        ).toBe(true)
      })

      it('profile field matches worker id', () => {
        expect(worker.profile ?? id).toBe(id)
      })

      it('profile model.default and swarm.yaml model agree', () => {
        const cfg = parseYaml(readFileSync(profileConfigPath, 'utf8')) as {
          model?: { default?: string; provider?: string }
        }
        expect(
          cfg?.model?.default,
          `swarm.yaml says '${worker.model}' but profile config.yaml says '${cfg?.model?.default}' — align them (see AGENTS.md operating rules)`,
        ).toBe(worker.model)
        expect(
          cfg?.model?.provider,
          'profile must pin a provider explicitly',
        ).toBeTruthy()
      })

      it('wrapper exists, is executable, and targets hermes -p <id>', () => {
        expect(existsSync(wrapperPath), `missing wrapper ${wrapperPath}`).toBe(
          true,
        )
        const mode = statSync(wrapperPath).mode
        expect(mode & 0o111, `${wrapperPath} is not executable`).not.toBe(0)
        const body = readFileSync(wrapperPath, 'utf8')
        expect(
          body,
          `${wrapperPath} must dispatch via 'hermes -p ${id}'`,
        ).toMatch(new RegExp(`hermes\\s+-p\\s+${id}(\\s|"|$)`))
      })
    },
  )

  it('no orphan worker wrappers missing from swarm.yaml', () => {
    const liveIds = new Set(workers.map((w) => w.id))
    const orphanCandidates = readdirSync(wrapperDir).filter((name) => {
      if (liveIds.has(name)) return false
      const p = join(wrapperDir, name)
      try {
        if (!statSync(p).isFile()) return false
        const body = readFileSync(p, 'utf8')
        // A swarm-worker wrapper is a tiny script exec-ing hermes -p <name>
        // where a profile dir of the same name exists.
        return (
          /hermes\s+-p\s+\S+/.test(body) &&
          body.length < 500 &&
          existsSync(join(profilesDir, name))
        )
      } catch {
        return false
      }
    })
    expect(
      orphanCandidates,
      `wrappers dispatching to hermes profiles but absent from swarm.yaml: ${orphanCandidates.join(', ')} — add to swarm.yaml or remove the wrapper`,
    ).toEqual([])
  })
})
