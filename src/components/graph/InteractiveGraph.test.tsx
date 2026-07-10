// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { InteractiveGraph } from './InteractiveGraph'

const sampleNodes = [
  { id: 'n1', title: 'Test Note', type: 'note', tags: ['test'] },
  { id: 's1', title: 'Test Skill', type: 'skill' },
]

const sampleEdges = [
  { source: 'n1', target: 's1' },
]

describe('InteractiveGraph', () => {
  it('renders without crashing and shows legend', () => {
    render(<InteractiveGraph nodes={sampleNodes} edges={sampleEdges} />)
    expect(screen.getByText(/Legend/i)).toBeInTheDocument()
    expect(screen.getByText(/Note/i)).toBeInTheDocument()
    expect(screen.getByText(/Skill/i)).toBeInTheDocument()
  })

  it('shows empty state when no nodes', () => {
    render(<InteractiveGraph nodes={[]} edges={[]} />)
    expect(screen.getByText(/No graph data available/i)).toBeInTheDocument()
  })

  it('renders node count in status', () => {
    render(<InteractiveGraph nodes={sampleNodes} edges={sampleEdges} />)
    expect(screen.getByText(/2 nodes/i)).toBeInTheDocument()
  })
})
