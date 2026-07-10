import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { InteractiveGraph, type GraphNode, type GraphEdge } from '@/components/graph/InteractiveGraph'
import { usePageTitle } from '@/hooks/use-page-title'

type KnowledgeGraphResponse = {
  nodes?: Array<{ id: string; title: string; type?: string; tags?: string[] }>
  edges?: Array<{ source: string; target: string }>
}

async function fetchKnowledgeGraph(): Promise<KnowledgeGraphResponse> {
  const res = await fetch('/api/knowledge/graph')
  if (!res.ok) throw new Error('Failed to load knowledge graph')
  return res.json()
}

export const Route = createFileRoute('/graph')({
  ssr: false,
  component: GraphPage,
})

function GraphPage() {
  usePageTitle('Graph')
  const [detailNode, setDetailNode] = useState<GraphNode | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['knowledge', 'graph', 'full'],
    queryFn: fetchKnowledgeGraph,
    staleTime: 60_000,
  })

  // Augment with deterministic workspace entities (skills, missions, workers)
  // This keeps data local and deterministic without new APIs or secrets
  const augmentedNodes: GraphNode[] = [
    ...(data?.nodes || []).map(n => ({ ...n, type: n.type || 'note' })),
    // Workers (from swarm.yaml roster)
    { id: 'worker:orchestrator', title: 'Orchestrator', type: 'worker', tags: ['routing', 'greenlight'] },
    { id: 'worker:researcher', title: 'Researcher', type: 'worker', tags: ['osint', 'synthesis'] },
    { id: 'worker:ops-watch', title: 'Ops-Watch', type: 'worker', tags: ['infra', 'health'] },
    { id: 'worker:librarian', title: 'Librarian', type: 'worker', tags: ['obsidian', 'llm-wiki', 'curation'] },
    { id: 'worker:builder', title: 'Builder', type: 'worker', tags: ['implementation', 'tdd'] },
    // Sample skills (from known skills)
    { id: 'skill:obsidian', title: 'obsidian', type: 'skill', tags: ['vault', 'notes'] },
    { id: 'skill:llm-wiki', title: 'llm-wiki', type: 'skill', tags: ['knowledge', 'graph'] },
    { id: 'skill:working-with-muhammad', title: 'working-with-muhammad', type: 'skill', tags: ['coordination'] },
    { id: 'skill:kanban-orchestrator', title: 'kanban-orchestrator', type: 'skill', tags: ['planning'] },
    // Sample missions (current conductor mission example)
    { id: 'mission:conductor-1783701059682', title: 'Build Interactive Graph View', type: 'mission', tags: ['ui', 'graph', 'workspace'] },
    { id: 'mission:knowledge-curation', title: 'Knowledge Curation', type: 'mission', tags: ['librarian', 'vault'] },
  ]

  const augmentedEdges: GraphEdge[] = [
    ...(data?.edges || []),
    // Synthetic links for demo connectivity (deterministic)
    { source: 'worker:librarian', target: 'skill:obsidian' },
    { source: 'worker:librarian', target: 'skill:llm-wiki' },
    { source: 'mission:conductor-1783701059682', target: 'worker:librarian' },
    { source: 'mission:conductor-1783701059682', target: 'skill:llm-wiki' },
    { source: 'worker:orchestrator', target: 'mission:conductor-1783701059682' },
    { source: 'skill:kanban-orchestrator', target: 'worker:orchestrator' },
    { source: 'worker:builder', target: 'mission:conductor-1783701059682' },
  ]

  const handleNodeSelect = (node: GraphNode) => {
    setDetailNode(node)
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="text-center">
          <div className="mb-3 text-4xl opacity-40">⟐</div>
          <div className="text-sm text-primary-500 dark:text-neutral-400">Loading workspace graph...</div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="mb-2 text-red-500">⚠ Graph load failed</div>
          <div className="text-sm text-primary-500 dark:text-neutral-400">{(error as Error).message}</div>
          <button 
            onClick={() => window.location.reload()} 
            className="mt-4 rounded-lg border px-4 py-1.5 text-sm"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  const hasData = augmentedNodes.length > 0

  return (
    <div className="flex h-full min-h-0 flex-col p-4 md:p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-primary-950 dark:text-white">Workspace Graph</h1>
          <p className="text-sm text-primary-500 dark:text-neutral-400">
            Obsidian-style view of notes, skills, missions, workers and their links
          </p>
        </div>
        <div className="text-xs text-primary-400 dark:text-neutral-500">
          Local deterministic data • No external services
        </div>
      </div>

      {!hasData ? (
        <div className="flex flex-1 items-center justify-center rounded-2xl border border-primary-200 bg-primary-50 dark:border-neutral-800 dark:bg-neutral-950">
          <div className="text-center text-sm text-primary-500 dark:text-neutral-400">
            No workspace data found. Ensure knowledge base is populated.
          </div>
        </div>
      ) : (
        <InteractiveGraph
          nodes={augmentedNodes}
          edges={augmentedEdges}
          onNodeSelect={handleNodeSelect}
          height={620}
        />
      )}

      {detailNode && (
        <div className="mt-2 text-xs text-primary-400 dark:text-neutral-500">
          Selected: {detailNode.title} ({detailNode.type})
        </div>
      )}
    </div>
  )
}
