// @vitest-environment jsdom
/**
 * Tests for GraphScreen — workspace graph screen.
 *
 * Uses React.act + createRoot directly (not @testing-library/react) to avoid
 * the vitest ESM/CJS dual-instance issue with React 19 hooks in jsdom.
 * (Same pattern as src/screens/mcp/-marketplace-install-confirmation.test.tsx)
 *
 * Network is stubbed: GraphScreen fetches /api/swarm-roster, /api/swarm-missions,
 * /api/skills and /api/knowledge/graph via react-query.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Mock the base-ui Button before importing the screen (vi.mock hoisting).
vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    ...props
  }: {
    children: React.ReactNode
    onClick?: () => void
    [k: string]: unknown
  }) => React.createElement('button', { onClick, ...props }, children),
}))

import { GraphScreen } from './graph-screen'

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response
}

const apiFixtures: Record<string, unknown> = {
  '/api/swarm-roster': {
    ok: true,
    roster: {
      workers: [
        { id: 'builder', name: 'Builder', role: 'implementation', skills: ['test-driven-development'] },
        { id: 'librarian', name: 'Librarian', role: 'knowledge', skills: ['obsidian'] },
      ],
    },
  },
  '/api/swarm-missions': {
    missions: [
      { id: 'm-1', task: 'Build graph view', state: 'executing', workerId: 'builder' },
    ],
  },
  '/api/skills': { skills: { 'test-driven-development': {}, obsidian: {} } },
  '/api/knowledge/graph': {
    nodes: [{ id: 'note-a', title: 'Note A' }],
    edges: [],
  },
}

const mounted: Array<{ root: Root; container: HTMLDivElement }> = []

function createClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
}

async function renderScreen(client: QueryClient) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await React.act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(GraphScreen),
      ),
    )
  })
  mounted.push({ root, container })
  return container
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const key = String(url)
      const match = Object.keys(apiFixtures).find((p) => key.includes(p))
      if (match) return jsonResponse(apiFixtures[match])
      return jsonResponse({})
    }),
  )
})

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

describe('GraphScreen', () => {
  it('renders loading state while queries are pending', async () => {
    // fetch that never resolves keeps queries in loading state
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    const container = await renderScreen(createClient())
    expect(container.textContent).toContain('Building workspace graph')
  })

  it('renders graph with workers, missions and legend once data loads', async () => {
    const container = await renderScreen(createClient())
    // Let react-query resolve the stubbed fetches
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    const text = container.textContent ?? ''
    expect(text).toContain('Workspace Graph')
    expect(text).toContain('Legend')
    expect(text).toContain('Workers')
    expect(text).toContain('Missions')
  })

  it('is exported as a function component', () => {
    expect(typeof GraphScreen).toBe('function')
  })
})
