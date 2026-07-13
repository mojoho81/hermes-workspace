import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { EMPTY_TASKS_SWARM_HINT } from './tasks-screen'

const tasksScreenPath = path.resolve(__dirname, 'tasks-screen.tsx')

/**
 * Regression — /tasks is a personal task board, but the agent swarm kanban
 * lives at /swarm2. An empty /tasks board with no signpost cost a support
 * round-trip (2026-07-13). When the board is empty we render a small hint
 * linking to /swarm2. Non-empty behavior is untouched.
 */
describe('tasks empty-state swarm signpost', () => {
  it('exposes hint copy pointing at /swarm2', () => {
    expect(EMPTY_TASKS_SWARM_HINT).toBe(
      "Looking for the agent swarm board? It's at /swarm2",
    )
  })

  it('renders the hint as a router link to /swarm2 only for the empty board', () => {
    const source = fs.readFileSync(tasksScreenPath, 'utf8')
    // Link target present
    expect(source).toContain('to="/swarm2"')
    // Hint is gated on an empty board (all tasks, not per-column)
    expect(source).toMatch(/tasks\.length === 0[\s\S]{0,200}EMPTY_TASKS_SWARM_HINT/)
  })
})
