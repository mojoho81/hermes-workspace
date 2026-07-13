import { describe, expect, it } from 'vitest'
import { isBareTemplateTask as serverExport } from '../routes/api/swarm-dispatch'
import { isBareTemplateTask } from './bare-template-task'

describe('isBareTemplateTask (shared module)', () => {
  it('flags unfilled quick-route templates', () => {
    expect(isBareTemplateTask('Use the research specialist for this:')).toBe(
      true,
    )
    expect(isBareTemplateTask('Use the builder specialist for this:')).toBe(
      true,
    )
    expect(isBareTemplateTask('use the pr / issues specialist for this:')).toBe(
      true,
    )
    expect(isBareTemplateTask('Use the docs specialist for this')).toBe(true)
    expect(isBareTemplateTask('   ')).toBe(true)
    expect(isBareTemplateTask('')).toBe(true)
  })

  it('flags short single-line prompts ending in a colon', () => {
    expect(isBareTemplateTask('Do the following:')).toBe(true)
  })

  it('accepts prompts with real task bodies', () => {
    expect(
      isBareTemplateTask(
        'Use the research specialist for this: profile bosnianbeauty89 archives',
      ),
    ).toBe(false)
    expect(
      isBareTemplateTask(
        'Use the builder specialist for this:\nFix the graph view test flake',
      ),
    ).toBe(false)
    expect(
      isBareTemplateTask('Sweep open PRs and summarise BenchLoop runs'),
    ).toBe(false)
    expect(
      isBareTemplateTask(
        'Rename config keys: HERMES_HOME, CLAUDE_HOME, and update the docs to match the new provider layout',
      ),
    ).toBe(false)
  })

  it('is the same function re-exported by the server dispatch route', () => {
    expect(serverExport).toBe(isBareTemplateTask)
  })
})
