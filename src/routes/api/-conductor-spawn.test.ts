import { describe, expect, it } from 'vitest'
import { SwarmRosterSchema, readSwarmRoster } from '../../server/swarm-roster'
import { NATIVE_CONDUCTOR_MODE_NOTE, buildNativeConductorAssignments, toNativeConductorMissionRecord } from './conductor-spawn'
import type { SwarmMission } from '../../server/swarm-missions'

// Fixture mirroring THIS install's semantic roster (swarm.yaml): no reviewer,
// no qa, no km-agent — the docs/knowledge lane is librarian.
const semanticRoster = SwarmRosterSchema.parse({
  version: 1,
  workers: [
    {
      id: 'orchestrator',
      name: 'Orchestrator',
      role: 'Mission routing / decomposition / greenlight gate',
      capabilities: ['orchestration', 'decomposition', 'routing', 'greenlight-gate'],
      preferredTaskTypes: ['orchestration', 'planning', 'routing', 'coordination'],
    },
    {
      id: 'researcher',
      name: 'Researcher',
      role: 'Research / OSINT / archives',
      capabilities: ['research', 'osint', 'synthesis', 'source-verification', 'archives'],
      preferredTaskTypes: ['research', 'analysis', 'osint', 'source-review', 'vetting'],
    },
    {
      id: 'ops-watch',
      name: 'Ops Watch',
      role: 'VPS infra / runtime health',
      capabilities: ['ops-health', 'gateway-status', 'runtime-monitoring', 'cron', 'backups'],
      preferredTaskTypes: ['ops', 'health', 'monitoring', 'incident-triage'],
    },
    {
      id: 'librarian',
      name: 'Librarian',
      role: 'Knowledge steward (Obsidian vault + llm-wiki)',
      capabilities: ['knowledge-curation', 'obsidian', 'wiki', 'documentation'],
      preferredTaskTypes: ['knowledge', 'curation', 'documentation', 'capture'],
    },
    {
      id: 'builder',
      name: 'Builder',
      role: 'Implementation / code + tooling executor',
      capabilities: ['implementation', 'coding', 'scripting', 'debugging', 'testing'],
      preferredTaskTypes: ['build', 'fix', 'implement', 'refactor', 'script'],
    },
  ],
})

// Fixture mirroring upstream's example roster (swarm.yaml.upstream-example)
// so the lane mapping provably still works for installs shaped like upstream.
const upstreamStyleRoster = SwarmRosterSchema.parse({
  version: 1,
  workers: [
    {
      id: 'builder',
      name: 'Builder',
      role: 'Scoped Implementation Agent',
      capabilities: ['implementation', 'code-editing', 'tests', 'integration', 'build-verification'],
      preferredTaskTypes: ['implementation', 'bugfix', 'feature', 'refactor', 'integration'],
    },
    {
      id: 'reviewer',
      name: 'Reviewer',
      role: 'Independent Review / Merge Gate',
      capabilities: ['code-review', 'security-review', 'regression-analysis', 'quality-gate', 'merge-readiness'],
      preferredTaskTypes: ['review', 'qa', 'regression', 'verification', 'merge-gate'],
    },
    {
      id: 'qa',
      name: 'QA',
      role: 'Browser / Workflow / CLI Smoke Verification',
      capabilities: ['browser-qa', 'smoke-verification', 'regression-reproduction', 'cli-verification', 'evidence-capture'],
      preferredTaskTypes: ['qa', 'smoke', 'browser', 'verification', 'regression'],
    },
    {
      id: 'ops-watch',
      name: 'Ops Watch',
      role: 'Local Infra / Runtime Health Watch',
      capabilities: ['ops-health', 'gateway-status', 'runtime-monitoring', 'cron', 'mcp-health', 'lifecycle-sweep'],
      preferredTaskTypes: ['ops', 'health', 'monitoring', 'lifecycle', 'incident-triage'],
    },
    {
      id: 'km-agent',
      name: 'KM Agent',
      role: 'RAZSOC / GBrain Knowledge Steward',
      capabilities: ['gbrain', 'razsoc', 'obsidian', 'tasknotes', 'drift-audit', 'knowledge-curation'],
      preferredTaskTypes: ['knowledge', 'curation', 'brain-health', 'drift', 'documentation'],
    },
  ],
})

const REPRESENTATIVE_GOALS = [
  'Fix conductor and make it production ready',
  'Create a small UI prototype',
  'Write docs and handoff for the release',
  'Review the latest changes and prepare a summary note',
  'Harden the gateway service and clean up runtime errors',
  'Research options and draft a plan',
]

describe('native Conductor fallback', () => {
  it('labels native-swarm as the official OOTB fallback when dashboard Conductor is unavailable', () => {
    expect(NATIVE_CONDUCTOR_MODE_NOTE).toContain('official Workspace-native Swarm fallback')
    expect(NATIVE_CONDUCTOR_MODE_NOTE).toContain('dashboard Conductor API')
  })

  it('decomposes production missions onto upstream-style lanes when those workers exist', () => {
    const assignments = buildNativeConductorAssignments('Fix conductor and make it production ready', {
      maxParallel: 4,
      supervised: false,
      roster: upstreamStyleRoster,
    })

    expect(assignments.map((assignment) => assignment.workerId)).toEqual(['ops-watch', 'builder', 'reviewer', 'qa'])
    expect(assignments[0].task).toContain('Conductor mission: Fix conductor')
    expect(assignments.every((assignment) => assignment.direct === true)).toBe(true)
    expect(assignments.every((assignment) => assignment.reviewRequired === false)).toBe(true)
  })

  it('routes the docs lane to the upstream knowledge steward when the roster has one', () => {
    const assignments = buildNativeConductorAssignments('Write docs and handoff for the release', {
      maxParallel: 3,
      supervised: true,
      roster: upstreamStyleRoster,
    })

    expect(assignments.map((assignment) => assignment.workerId)).toContain('km-agent')
    expect(assignments.some((assignment) => assignment.task.includes('Supervised mode'))).toBe(true)
  })

  it('does not collapse generic two-lane missions to a single worker on rosters with a review lane', () => {
    const assignments = buildNativeConductorAssignments('Create a small UI prototype', {
      maxParallel: 2,
      supervised: false,
      roster: upstreamStyleRoster,
    })

    expect(assignments.map((assignment) => assignment.workerId)).toEqual(['builder', 'reviewer'])
  })

  it('never emits upstream-only worker ids on the semantic roster', () => {
    const assignments = buildNativeConductorAssignments('Fix conductor and make it production ready', {
      maxParallel: 4,
      supervised: false,
      roster: semanticRoster,
    })

    const ids = assignments.map((assignment) => assignment.workerId)
    expect(ids).toEqual(['ops-watch', 'builder'])
    expect(ids).not.toContain('reviewer')
    expect(ids).not.toContain('qa')
    expect(ids).not.toContain('km-agent')
  })

  it('routes docs missions to librarian on the semantic roster (the km-agent bug)', () => {
    const assignments = buildNativeConductorAssignments('Write docs and handoff for the release', {
      maxParallel: 3,
      supervised: true,
      roster: semanticRoster,
    })

    const ids = assignments.map((assignment) => assignment.workerId)
    expect(ids).toContain('librarian')
    expect(ids).not.toContain('km-agent')
    expect(assignments.some((assignment) => assignment.task.includes('Supervised mode'))).toBe(true)
  })

  it('forces the docs lane in even at maxParallel 1 when a knowledge worker exists', () => {
    const assignments = buildNativeConductorAssignments('Write docs and handoff for the release', {
      maxParallel: 1,
      supervised: false,
      roster: semanticRoster,
    })

    expect(assignments.map((assignment) => assignment.workerId)).toEqual(['librarian'])
  })

  it('skips the docs lane instead of inventing a worker when no knowledge worker exists', () => {
    const noDocsRoster = SwarmRosterSchema.parse({
      version: 1,
      workers: semanticRoster.workers.filter((worker) => worker.id !== 'librarian'),
    })
    const assignments = buildNativeConductorAssignments('Write docs and handoff for the release', {
      maxParallel: 3,
      supervised: false,
      roster: noDocsRoster,
    })

    expect(assignments.length).toBeGreaterThan(0)
    const rosterIds = new Set(noDocsRoster.workers.map((worker) => worker.id))
    for (const assignment of assignments) {
      expect(rosterIds.has(assignment.workerId), `emitted '${assignment.workerId}' which is not in the roster`).toBe(true)
    }
  })

  it('falls back to the first rostered worker when no lane matches, and emits nothing on an empty roster', () => {
    const oddRoster = SwarmRosterSchema.parse({
      version: 1,
      workers: [{ id: 'strategist', name: 'Strategist', role: 'Wedges / Bets / Kill Criteria' }],
    })
    const fallback = buildNativeConductorAssignments('Fix conductor and make it production ready', {
      maxParallel: 3,
      supervised: false,
      roster: oddRoster,
    })
    expect(fallback.map((assignment) => assignment.workerId)).toEqual(['strategist'])

    const empty = buildNativeConductorAssignments('Fix conductor and make it production ready', {
      maxParallel: 3,
      supervised: false,
      roster: SwarmRosterSchema.parse({ version: 1, workers: [] }),
    })
    expect(empty).toEqual([])
  })

  describe('live roster alignment (readSwarmRoster)', () => {
    // Roster-derived like swarm-foundation.test.ts: never hardcode worker ids
    // for the live install — assert against whatever swarm.yaml says.
    const liveRoster = readSwarmRoster()
    const liveIds = new Set(liveRoster.workers.map((worker) => worker.id))

    it.skipIf(liveRoster.workers.length === 0)(
      'every assignment across representative goals and lane counts targets a rostered worker',
      () => {
        for (const goal of REPRESENTATIVE_GOALS) {
          for (const maxParallel of [1, 2, 3, 4, 5]) {
            for (const supervised of [false, true]) {
              const assignments = buildNativeConductorAssignments(goal, { maxParallel, supervised })
              expect(assignments.length, `no assignments for goal '${goal}'`).toBeGreaterThan(0)
              const ids = assignments.map((assignment) => assignment.workerId)
              expect(new Set(ids).size, `duplicate workers for goal '${goal}' @${maxParallel}: ${ids.join(', ')}`).toBe(ids.length)
              for (const id of ids) {
                expect(
                  liveIds.has(id),
                  `goal '${goal}' @maxParallel=${maxParallel} emitted '${id}' which is not in swarm.yaml (${[...liveIds].join(', ')})`,
                ).toBe(true)
              }
            }
          }
        }
      },
    )
  })

  it('normalizes native swarm missions into the Conductor mission status contract', () => {
    const mission: SwarmMission = {
      id: 'conductor-test',
      title: 'Conductor: smoke',
      state: 'executing',
      createdAt: 1,
      updatedAt: 2,
      assignments: [
        {
          id: 'a1',
          workerId: 'builder',
          task: 'Run smoke',
          rationale: 'Builder',
          dependsOn: [],
          reviewRequired: false,
          state: 'dispatched',
          dispatchedAt: 1,
          completedAt: null,
          reviewedAt: null,
          reviewedBy: null,
          checkpoint: null,
        },
      ],
      events: [
        { id: 'e1', type: 'created', at: 1, message: 'Mission created' },
      ],
    }

    const record = toNativeConductorMissionRecord(mission)
    expect(record.id).toBe('conductor-test')
    expect(record.status).toBe('running')
    expect(record.nativeSwarm).toBe(true)
    expect(record.modeOfficialOotb).toBe(true)
    expect(record.modeNote).toBe(NATIVE_CONDUCTOR_MODE_NOTE)
    expect(record.lines.join('\n')).toContain('builder dispatched')
  })
})
