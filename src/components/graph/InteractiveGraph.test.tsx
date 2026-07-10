// @vitest-environment jsdom
/**
 * Tests for InteractiveGraph — workspace graph view.
 *
 * Uses React.act + createRoot directly (not @testing-library/react) to avoid
 * the vitest ESM/CJS dual-instance issue with React 19 hooks in jsdom.
 * (Same pattern as src/screens/mcp/-marketplace-install-confirmation.test.tsx)
 */
import { describe, it, expect, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { InteractiveGraph } from './InteractiveGraph'

const sampleNodes = [
  { id: 'n1', title: 'Test Note', type: 'note', tags: ['test'] },
  { id: 's1', title: 'Test Skill', type: 'skill' },
]

const sampleEdges = [{ source: 'n1', target: 's1' }]

const mounted: Array<{ root: Root; container: HTMLDivElement }> = []

async function renderInto(element: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await React.act(async () => {
    root.render(element)
  })
  mounted.push({ root, container })
  return container
}

afterEach(async () => {
  while (mounted.length) {
    const { root, container } = mounted.pop()!
    await React.act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

describe('InteractiveGraph', () => {
  it('renders without crashing and shows legend', async () => {
    const container = await renderInto(
      <InteractiveGraph nodes={sampleNodes} edges={sampleEdges} />,
    )
    const text = container.textContent ?? ''
    expect(text).toContain('Legend')
    expect(text.toLowerCase()).toContain('note')
    expect(text.toLowerCase()).toContain('skill')
  })

  it('shows empty state when no nodes', async () => {
    const container = await renderInto(<InteractiveGraph nodes={[]} edges={[]} />)
    expect(container.textContent).toContain('No graph data available')
  })

  it('renders node count in status', async () => {
    const container = await renderInto(
      <InteractiveGraph nodes={sampleNodes} edges={sampleEdges} />,
    )
    expect(container.textContent).toContain('2 nodes')
  })
})
