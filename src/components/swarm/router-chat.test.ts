// @vitest-environment jsdom
/**
 * Tests for RouterChat — swarm router chat dock.
 *
 * Component tests use React.act + createRoot directly (not
 * @testing-library/react) to avoid the vitest ESM/CJS dual-instance issue
 * with React 19 hooks in jsdom. (Same pattern as
 * src/screens/graph/graph-screen.test.tsx.)
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RouterChat } from './router-chat'

const reactActGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean
}
reactActGlobal.IS_REACT_ACT_ENVIRONMENT = true

function source(): string {
  return readFileSync(
    join(process.cwd(), 'src/components/swarm/router-chat.tsx'),
    'utf-8',
  )
}

describe('RouterChat dispatch request', () => {
  it('does not block route mission UI while waiting for worker checkpoints', () => {
    const src = source()

    expect(src).toContain("fetch('/api/swarm-dispatch'")
    expect(src).toContain('waitForCheckpoint: false')
    expect(src).not.toContain('checkpointPollSeconds: 90')
  })

  it('shares the server-side bare-template predicate instead of duplicating it', () => {
    const src = source()

    // The regex must NOT be copy-pasted into the component — the single
    // source of truth is src/lib/bare-template-task.ts.
    expect(src).toContain("from '@/lib/bare-template-task'")
    expect(src).not.toContain('specialist for this:?$')
  })
})

const mounted: Array<{ root: Root; container: HTMLDivElement }> = []

async function renderRouterChat(seedPrompt: string) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await React.act(async () => {
    root.render(
      React.createElement(RouterChat, {
        members: [],
        roomIds: [],
        selectedId: null,
        open: true,
        onClose: () => {},
        onResults: () => {},
        seedPrompt,
        seedKey: 1,
      }),
    )
  })
  mounted.push({ root, container })
  return container
}

function dispatchButton(container: HTMLElement): HTMLButtonElement {
  // Label depends on mode: 'Route mission' (auto), 'Send to …' (manual),
  // 'Broadcast to …' (broadcast). Tests run in the default auto mode.
  const button = Array.from(container.querySelectorAll('button')).find((el) =>
    /route mission|send to|broadcast to/i.test(el.textContent ?? ''),
  )
  if (!button) throw new Error('dispatch button not found')
  return button
}

afterEach(async () => {
  while (mounted.length) {
    const { root, container } = mounted.pop()!
    await React.act(async () => {
      root.unmount()
    })
    container.remove()
  }
  vi.unstubAllGlobals()
})

describe('RouterChat bare-template guard', () => {
  it('disables dispatch and shows the inline warning for an unfilled quick-route template', async () => {
    const container = await renderRouterChat('Use the builder specialist for this:')

    expect(container.textContent).toContain(
      'Add your task after the colon before dispatching.',
    )
    expect(dispatchButton(container).disabled).toBe(true)
  })

  it('does not warn and enables dispatch once a real task follows the template', async () => {
    const container = await renderRouterChat(
      'Use the builder specialist for this: fix the graph view test flake',
    )

    expect(container.textContent).not.toContain(
      'Add your task after the colon before dispatching.',
    )
    expect(dispatchButton(container).disabled).toBe(false)
  })

  it('keeps dispatch disabled for an empty prompt without showing the warning', async () => {
    const container = await renderRouterChat('')

    expect(container.textContent).not.toContain(
      'Add your task after the colon before dispatching.',
    )
    expect(dispatchButton(container).disabled).toBe(true)
  })

  it('never issues the dispatch fetch for a bare template even if invoked', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const container = await renderRouterChat('Use the research specialist for this:')

    const button = dispatchButton(container)
    await React.act(async () => {
      button.disabled = false // simulate a stale/bypassed disabled state
      button.click()
    })

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
