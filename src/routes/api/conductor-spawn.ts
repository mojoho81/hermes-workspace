import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import { dashboardFetch, ensureGatewayProbed } from '../../server/gateway-capabilities'
import { sanitizeConductorMissionGoal } from '../../server/conductor-mission-sanitize'
import { getSwarmMission, recordMissionCheckpoint  } from '../../server/swarm-missions'
import { getSwarmProfilePath } from '../../server/swarm-foundation'
import { readWorkerMessages } from '../../server/swarm-chat-reader'
import { newestCheckpointFromMessages } from '../../server/swarm-checkpoints'
import { readSwarmRoster, resolveSwarmWorkerDisplayName } from '../../server/swarm-roster'
import { checkpointFromRuntimeSnapshot, dispatchSwarmAssignments, readRuntimeCheckpointSnapshot, runtimeCheckpointSignature } from './swarm-dispatch'
import type { SwarmRoster, SwarmRosterWorker } from '../../server/swarm-roster'
import type { SwarmMission } from '../../server/swarm-missions'

let cachedSkill: string | null = null

export const NATIVE_CONDUCTOR_MODE_NOTE = 'Native-swarm is the official Workspace-native Swarm fallback when the dashboard Conductor API is unavailable.'

type ConductorSpawnBody = {
  goal?: unknown
  orchestratorModel?: unknown
  workerModel?: unknown
  projectsDir?: unknown
  maxParallel?: unknown
  supervised?: unknown
}

function repoRoot(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    return resolve(here, '..', '..', '..')
  } catch {
    return process.cwd()
  }
}

function loadDispatchSkill(): string {
  if (cachedSkill !== null) return cachedSkill
  const home = process.env.HOME ?? ''
  const candidates = [
    resolve(repoRoot(), 'skills/workspace-dispatch/SKILL.md'),
    resolve(process.cwd(), 'skills/workspace-dispatch/SKILL.md'),
    ...(home ? [resolve(home, '.hermes/skills/workspace-dispatch/SKILL.md')] : []),
    ...(home ? [resolve(home, '.openclaw/workspace/skills/workspace-dispatch/SKILL.md')] : []),
  ]
  for (const p of candidates) {
    try {
      cachedSkill = readFileSync(p, 'utf-8')
      return cachedSkill
    } catch {}
  }
  cachedSkill = ''
  return cachedSkill
}

function readOptionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readMaxParallel(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.min(5, Math.max(1, Math.round(value)))
}

function buildOrchestratorPrompt(
  goal: string,
  skill: string,
  options: {
    orchestratorModel: string
    workerModel: string
    projectsDir: string
    maxParallel: number
    supervised: boolean
  },
): string {
  const outputBase = options.projectsDir || '/tmp'
  const outputPrefix = outputBase === '/tmp' ? '/tmp/dispatch-<slug>' : `${outputBase}/dispatch-<slug>`
  return [
    'You are a mission orchestrator. Execute this mission autonomously.',
    '',
    '## Dispatch Skill Instructions',
    '',
    skill || '(workspace-dispatch skill not found locally; proceed using create_task to spawn workers)',
    '',
    '## Mission',
    '',
    `Goal: ${goal}`,
    ...(options.orchestratorModel ? ['', `Use model: ${options.orchestratorModel} for the orchestrator`] : []),
    ...(options.workerModel ? ['', `Use model: ${options.workerModel} for all workers`] : []),
    ...(options.maxParallel > 1
      ? ['', `Run up to ${options.maxParallel} workers in parallel when tasks are independent`]
      : ['', 'Spawn workers one at a time. Do NOT wait for workers to finish — the UI handles tracking.']),
    ...(options.supervised ? ['', 'Supervised mode is enabled. Require approval before each task.'] : []),
    '',
    '## Critical Rules',
    '- Use create_task / delegate_task to create worker agents for each task',
    '- Do NOT do the work yourself — spawn workers',
    '- For simple tasks (single file, quick mockup), use ONLY 1 task with 1 worker — do not over-decompose',
    '- Do NOT ask for confirmation — start immediately',
    '- Label workers as "worker-<task-slug>" so the UI can track them',
    '- Each worker gets a self-contained prompt with the task + exit criteria',
    `- Workers should write output to ${outputPrefix} directories`,
    '- After spawning all workers, report your plan summary and finish. The UI tracks worker completion automatically.',
    '- Report a summary when all tasks are done',
  ].join('\n')
}

async function createDashboardConductorMission(payload: { name: string; prompt: string }): Promise<{
  id?: string
  name?: string
  sessionKey?: string
  error?: string
}> {
  const res = await dashboardFetch('/api/conductor/missions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: payload.name, prompt: payload.prompt }),
  })
  const text = await res.text()
  let data: { id?: string; name?: string; session_id?: string; error?: string; detail?: string } = {}
  try {
    data = JSON.parse(text)
  } catch {
    return { error: text || `HTTP ${res.status}` }
  }
  if (!res.ok || data.error || data.detail) {
    return { error: data.error || data.detail || `HTTP ${res.status}` }
  }
  return { id: data.id, name: data.name, sessionKey: data.session_id }
}

type NativeConductorAssignment = {
  workerId: string
  task: string
  rationale: string
  reviewRequired?: boolean
  direct?: boolean
  raw?: boolean
}

function clipText(value: string, max = 8000): string {
  return value.length <= max ? value : `${value.slice(0, max - 20)}\n...[truncated]`
}

/**
 * Conductor lane intents. Assignments are derived from the LIVE swarm roster
 * (swarm.yaml via readSwarmRoster) by matching each lane's intent against
 * worker capabilities / preferredTaskTypes / role — never from hardcoded
 * worker ids. Lanes with no matching rostered worker are skipped; every
 * emitted workerId is guaranteed to exist in the roster.
 */
type ConductorLaneId = 'implementation' | 'ops' | 'review' | 'qa' | 'docs'

type ConductorLane = {
  id: ConductorLaneId
  // Matched as full lowercase strings against capabilities/preferredTaskTypes
  // and as single lowercase tokens against the role text.
  matchTerms: ReadonlyArray<string>
  rationale: (workerName: string) => string
  laneLabel: (workerName: string) => string
  briefing: string
}

const CONDUCTOR_LANES: Record<ConductorLaneId, ConductorLane> = {
  implementation: {
    id: 'implementation',
    matchTerms: [
      'implementation', 'implement', 'coding', 'code', 'code-editing', 'builder', 'build',
      'feature', 'bugfix', 'fix', 'refactor', 'integration', 'script', 'scripting', 'tooling',
    ],
    rationale: (name) => `${name} owns scoped implementation and concrete progress.`,
    laneLabel: (name) => `Lane: ${name} / primary implementation.`,
    briefing:
      'Find the smallest safe execution plan, make concrete progress, and produce a checkpoint. If code changes are required, keep them scoped and testable. Report files changed, tests run, and remaining risks.',
  },
  ops: {
    id: 'ops',
    matchTerms: [
      'ops', 'ops-health', 'operations', 'infra', 'infrastructure', 'runtime',
      'runtime-monitoring', 'monitoring', 'health', 'gateway-status', 'incident-triage',
      'lifecycle', 'lifecycle-sweep', 'sre', 'devops', 'backups', 'cron',
    ],
    rationale: (name) => `${name} owns runtime health, service quality, and production blockers.`,
    laneLabel: (name) => `Lane: ${name} / runtime quality.`,
    briefing:
      'Diagnose the runtime path, check service/deployment/operational risk, and make the smallest safe operational improvement with proof. Avoid destructive changes unless explicitly approved.',
  },
  review: {
    id: 'review',
    matchTerms: [
      'review', 'reviewer', 'code-review', 'security-review', 'quality-gate',
      'merge-gate', 'merge-readiness', 'regression-analysis', 'quality',
    ],
    rationale: (name) => `${name} independently checks correctness, regressions, and merge risk.`,
    laneLabel: (name) => `Lane: ${name} / quality gate.`,
    briefing:
      'Review the execution path and any changes. Look for regressions, missing tests, unsafe assumptions, and production-readiness gaps. Do not make broad edits unless needed to unblock correctness.',
  },
  qa: {
    id: 'qa',
    matchTerms: [
      'qa', 'browser-qa', 'smoke', 'smoke-verification', 'verification',
      'cli-verification', 'evidence-capture', 'regression', 'regression-reproduction', 'browser',
    ],
    rationale: (name) => `${name} validates user-visible behavior with focused smoke checks.`,
    laneLabel: (name) => `Lane: ${name} / verification.`,
    briefing:
      'Run or design focused verification. Prefer targeted tests/build/smoke checks. Report exact commands and results. If tests are missing, identify the minimal regression coverage needed.',
  },
  docs: {
    id: 'docs',
    matchTerms: [
      'docs', 'doc', 'documentation', 'knowledge', 'knowledge-curation', 'curation',
      'wiki', 'obsidian', 'handoff', 'capture', 'librarian', 'writing', 'notes',
    ],
    rationale: (name) => `${name} captures handoff, docs, and durable knowledge notes without leaking secrets.`,
    laneLabel: (name) => `Lane: ${name} / handoff and knowledge hygiene.`,
    briefing:
      'Create a concise handoff/status note: what changed, how to operate it, verification, caveats, and next actions. Do not expose secrets.',
  },
}

function conductorLaneMatchScore(worker: SwarmRosterWorker, terms: ReadonlyArray<string>): number {
  const termSet = new Set(terms)
  let score = 0
  for (const value of [...worker.capabilities, ...worker.preferredTaskTypes]) {
    if (termSet.has(value.trim().toLowerCase())) score += 1
  }
  const roleTokens = new Set(worker.role.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean))
  for (const token of roleTokens) {
    if (termSet.has(token)) score += 1
  }
  return score
}

function resolveConductorLaneWorker(
  lane: ConductorLane,
  workers: ReadonlyArray<SwarmRosterWorker>,
  used: ReadonlySet<string>,
): SwarmRosterWorker | null {
  let best: SwarmRosterWorker | null = null
  let bestScore = 0
  for (const worker of workers) {
    if (used.has(worker.id)) continue
    const score = conductorLaneMatchScore(worker, lane.matchTerms)
    if (score > bestScore) {
      best = worker
      bestScore = score
    }
  }
  return best
}

function buildConductorLaneAssignment(
  lane: ConductorLane,
  worker: SwarmRosterWorker,
  goal: string,
  supervised: boolean,
): NativeConductorAssignment {
  const name = resolveSwarmWorkerDisplayName(worker.id, worker)
  return {
    workerId: worker.id,
    rationale: lane.rationale(name),
    reviewRequired: false,
    direct: true,
    task: [
      `Conductor mission: ${goal}`,
      '',
      lane.laneLabel(name),
      lane.briefing,
      supervised
        ? 'Supervised mode: stop before destructive writes or commits and report the exact approval needed.'
        : 'Do not ask for confirmation unless blocked; start immediately.',
    ].join('\n'),
  }
}

export function buildNativeConductorAssignments(
  goal: string,
  options: { maxParallel: number; supervised: boolean; roster?: SwarmRoster },
): Array<NativeConductorAssignment> {
  const maxParallel = Math.min(5, Math.max(1, options.maxParallel || 1))
  const roster = options.roster ?? readSwarmRoster()
  const workers = roster.workers
  if (workers.length === 0) return []

  const normalizedGoal = goal.toLowerCase()
  const wantsOps = /production|ready|harden|audit|clean|fix|bug|test|build|release|deploy|operational|runtime|gateway|tmux|service|health/.test(normalizedGoal)
  const wantsDocs = /doc|handoff|readme|spec|plan|summary|knowledge|note/.test(normalizedGoal)

  const laneOrder: Array<ConductorLaneId> = wantsOps
    ? ['ops', 'implementation', 'review', 'qa']
    : ['implementation', 'review', 'qa', 'ops']
  if (maxParallel >= 5 || wantsDocs) laneOrder.push('docs')

  const used = new Set<string>()
  const candidates: Array<NativeConductorAssignment> = []
  let docsAssignment: NativeConductorAssignment | null = null
  for (const laneId of laneOrder) {
    const lane = CONDUCTOR_LANES[laneId]
    const worker = resolveConductorLaneWorker(lane, workers, used)
    if (!worker) continue
    used.add(worker.id)
    const assignment = buildConductorLaneAssignment(lane, worker, goal, options.supervised)
    if (laneId === 'docs') docsAssignment = assignment
    candidates.push(assignment)
  }

  // No lane matched this roster at all: fall back to the first rostered
  // worker rather than emitting a workerId that does not exist.
  if (candidates.length === 0) {
    candidates.push(buildConductorLaneAssignment(CONDUCTOR_LANES.implementation, workers[0], goal, options.supervised))
  }

  const selected = candidates.slice(0, maxParallel)
  if (wantsDocs && docsAssignment) {
    const docsId = docsAssignment.workerId
    if (!selected.some((assignment) => assignment.workerId === docsId)) {
      selected[selected.length - 1] = docsAssignment
    }
  }

  return selected
}

function swarmMissionStatus(mission: SwarmMission): string {
  if (mission.state === 'cancelled') return 'cancelled'
  if (mission.state === 'complete') return 'completed'
  if (mission.state === 'blocked') return 'failed'
  return 'running'
}

function nativeMissionLines(mission: SwarmMission, maxLines: number): Array<string> {
  const lines = [
    `Native Workspace Swarm mission: ${mission.title}`,
    `mission_id: ${mission.id}`,
    `state: ${mission.state}`,
    ...mission.assignments.map((assignment) => {
      const result = assignment.checkpoint?.result ? ` — ${assignment.checkpoint.result}` : ''
      const blocker = assignment.checkpoint?.blocker ? ` — blocker: ${assignment.checkpoint.blocker}` : ''
      return `${assignment.workerId} ${assignment.state}: ${assignment.task.slice(0, 160)}${result}${blocker}`
    }),
    ...mission.events.slice(-20).map((event) => `${new Date(event.at).toISOString()} ${event.type}: ${event.message}`),
  ]
  return lines.slice(-maxLines)
}

export function toNativeConductorMissionRecord(mission: SwarmMission, maxLines = 400) {
  return {
    id: mission.id,
    name: mission.title,
    status: swarmMissionStatus(mission),
    error: mission.state === 'blocked' ? 'Native Workspace Swarm mission blocked' : null,
    session_id: null,
    lines: nativeMissionLines(mission, maxLines),
    exit_code: mission.state === 'blocked' || mission.state === 'cancelled' ? 1 : mission.state === 'complete' ? 0 : null,
    nativeSwarm: true,
    modeOfficialOotb: true,
    modeNote: NATIVE_CONDUCTOR_MODE_NOTE,
    assignments: mission.assignments,
    updatedAt: mission.updatedAt,
  }
}

function createNativeConductorMission(input: {
  goal: string
  missionName: string
  maxParallel: number
  supervised: boolean
}) {
  const assignments = buildNativeConductorAssignments(input.goal, {
    maxParallel: input.maxParallel,
    supervised: input.supervised,
  })
  const missionTitle = `Conductor: ${clipText(input.goal, 120)}`
  void dispatchSwarmAssignments({
    assignments,
    missionId: input.missionName,
    missionTitle,
    allowAsync: true,
    waitForCheckpoint: false,
    timeoutSeconds: 600,
    checkpointPollSeconds: 10,
    notifySessionKey: 'main',
  }).catch((error) => {
    console.error('[conductor] native swarm dispatch failed:', error instanceof Error ? error.message : String(error))
  })
  return { missionId: input.missionName, missionTitle, assignments }
}

export const Route = createFileRoute('/api/conductor-spawn')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        const url = new URL(request.url)
        const missionId = url.searchParams.get('missionId')?.trim()
        const requestedLines = Number(url.searchParams.get('lines') || '200')
        const lines = Number.isFinite(requestedLines) ? Math.min(2000, Math.max(1, requestedLines)) : 200
        if (!missionId) return json({ ok: false, error: 'missionId required' }, { status: 400 })

        const nativeMission = getSwarmMission(missionId)
        if (nativeMission) {
          // For active native missions, check worker runtime.json for fresh
          // checkpoints that haven't been written back to the mission store yet.
          // This bridges the gap between fire-and-forget dispatch (waitForCheckpoint=false)
          // and the conductor UI polling for live status.
          if (nativeMission.state === 'executing') {
            for (const assignment of nativeMission.assignments) {
              if (assignment.state === 'dispatched' && assignment.workerId) {
                try {
                  const profilePath = getSwarmProfilePath(assignment.workerId)
                  // Check runtime.json first
                  const snapshot = readRuntimeCheckpointSnapshot(profilePath)
                  let checkpoint = checkpointFromRuntimeSnapshot(snapshot)

                  // Also check the worker's chat SQLite DB for checkpoint messages
                  // (tmux workers write checkpoints there)
                  if (!checkpoint || checkpoint.stateLabel === 'IN_PROGRESS') {
                    const chat = readWorkerMessages(profilePath, 50)
                    if (chat.ok) {
                      const msgCheckpoint = newestCheckpointFromMessages(chat.messages)
                      if (msgCheckpoint && msgCheckpoint.raw !== snapshot.checkpointRaw) {
                        checkpoint = msgCheckpoint
                      }
                    }
                  }

                  if (checkpoint && (checkpoint.stateLabel === 'DONE' || checkpoint.stateLabel === 'BLOCKED' || checkpoint.stateLabel === 'HANDOFF' || checkpoint.stateLabel === 'NEEDS_INPUT')) {
                    recordMissionCheckpoint({
                      missionId: nativeMission.id,
                      assignmentId: assignment.id,
                      workerId: assignment.workerId,
                      checkpoint,
                      source: 'conductor-poll',
                    })
                  }
                } catch {
                  // runtime.json might not exist yet or be temporarily unreadable
                }
              }
            }
          }
          // Re-read the mission from the store so the response reflects any
          // checkpoints just synced via recordMissionCheckpoint above.
          const updatedNative = getSwarmMission(missionId) ?? nativeMission
          return json({ ok: true, mode: 'native-swarm', mission: toNativeConductorMissionRecord(updatedNative, lines) })
        }

        const capabilities = await ensureGatewayProbed()
        if (!capabilities.dashboard.available || !capabilities.conductor) {
          return json({ ok: false, error: 'Conductor mission not found in native swarm store and dashboard Conductor API is unavailable' }, { status: 404 })
        }

        const res = await dashboardFetch(`/api/conductor/missions/${encodeURIComponent(missionId)}?lines=${lines}`)
        const text = await res.text()
        let mission: Record<string, unknown> = {}
        try {
          mission = JSON.parse(text) as Record<string, unknown>
        } catch {
          return json({ ok: false, error: text || `HTTP ${res.status}` }, { status: res.ok ? 502 : res.status })
        }
        if (!res.ok) {
          const error = typeof mission.detail === 'string' ? mission.detail : typeof mission.error === 'string' ? mission.error : `HTTP ${res.status}`
          return json({ ok: false, error }, { status: res.status })
        }
        return json({ ok: true, mission })
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        try {
          const body = (await request.json().catch(() => ({}))) as ConductorSpawnBody
          const rawGoal = readOptionalString(body.goal)
          const goalSanitization = sanitizeConductorMissionGoal(rawGoal)
          const goal = goalSanitization.goal
          const orchestratorModel = readOptionalString(body.orchestratorModel)
          const workerModel = readOptionalString(body.workerModel)
          const projectsDir = readOptionalString(body.projectsDir)
          const maxParallel = readMaxParallel(body.maxParallel)
          const supervised = body.supervised === true
          if (!goal) {
            return json(
              {
                ok: false,
                error: goalSanitization.removedCloudflareErrorPage
                  ? 'mission goal only contained a Cloudflare 5xx HTML error page; enter the original mission goal and retry'
                  : 'goal required',
                warnings: goalSanitization.warnings,
              },
              { status: 400 },
            )
          }

          const prompt = buildOrchestratorPrompt(goal, loadDispatchSkill(), {
            orchestratorModel,
            workerModel,
            projectsDir,
            maxParallel,
            supervised,
          })
          const missionName = `conductor-${Date.now()}`
          const capabilities = await ensureGatewayProbed()

          if (!capabilities.dashboard.available || !capabilities.conductor) {
            const native = createNativeConductorMission({
              goal,
              missionName,
              maxParallel,
              supervised,
            })
            return json({
              ok: true,
              mode: 'native-swarm',
              modeOfficialOotb: true,
              modeNote: NATIVE_CONDUCTOR_MODE_NOTE,
              prompt: null,
              missionId: native.missionId,
              sessionKey: null,
              sessionKeyPrefix: null,
              jobId: native.missionId,
              jobName: native.missionTitle,
              runId: null,
              warnings: goalSanitization.warnings,
              assignments: native.assignments,
              results: null,
            })
          }

          const result = await createDashboardConductorMission({ name: missionName, prompt })
          if (result.error) return json({ ok: false, error: result.error }, { status: 502 })
          const missionId = result.id ?? missionName
          return json({
            ok: true,
            mode: 'dashboard',
            prompt: null,
            missionId,
            sessionKey: result.sessionKey ?? null,
            sessionKeyPrefix: (result as Record<string, unknown>).sessionKeyPrefix ?? null,
            jobId: missionId,
            jobName: result.name ?? missionName,
            runId: null,
            warnings: goalSanitization.warnings,
          })
        } catch (error) {
          return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 })
        }
      },
    },
  },
})
