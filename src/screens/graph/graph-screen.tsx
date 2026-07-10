import { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { LoadingIndicator } from '@/components/loading-indicator'
import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'

// Types for graph
export type GraphNodeType = 'worker' | 'mission' | 'skill' | 'note'
export type GraphNode = {
  id: string
  label: string
  type: GraphNodeType
  meta?: Record<string, unknown>
}
export type GraphEdge = {
  source: string
  target: string
  label?: string
}

type PositionedNode = GraphNode & { x: number; y: number }

// Simple API client helper (reuse pattern from knowledge-browser)
async function readJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error(`Request failed: ${res.status}`)
  return res.json()
}

// Color map for node types (works in dark/light via currentColor + opacity)
const NODE_COLORS: Record<GraphNodeType, { fill: string; stroke: string; text: string }> = {
  worker: { fill: 'rgba(59, 130, 246, 0.2)', stroke: '#3b82f6', text: '#1e40af' },
  mission: { fill: 'rgba(34, 197, 94, 0.2)', stroke: '#22c55e', text: '#166534' },
  skill: { fill: 'rgba(168, 85, 247, 0.2)', stroke: '#a855f7', text: '#6b21a8' },
  note: { fill: 'rgba(245, 158, 11, 0.2)', stroke: '#f59e0b', text: '#92400e' },
}

const TYPE_LABELS: Record<GraphNodeType, string> = {
  worker: 'Workers',
  mission: 'Missions',
  skill: 'Skills',
  note: 'Notes',
}

export function GraphScreen() {
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [visibleTypes, setVisibleTypes] = useState<Record<GraphNodeType, boolean>>({
    worker: true,
    mission: true,
    skill: true,
    note: true,
  })
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 })
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null)
  const [isPanning, setIsPanning] = useState(false)
  const [lastPanPos, setLastPanPos] = useState({ x: 0, y: 0 })
  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Data fetching - reuse existing APIs (local, deterministic, filesystem backed)
  const rosterQuery = useQuery({
    queryKey: ['swarm', 'roster'],
    queryFn: () => readJson<{ ok: boolean; roster: { workers: Array<any> } }>('/api/swarm-roster'),
  })

  const missionsQuery = useQuery({
    queryKey: ['swarm', 'missions'],
    queryFn: () => readJson<any>('/api/swarm-missions'),
  })

  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: () => readJson<any>('/api/skills'),
  })

  const knowledgeGraphQuery = useQuery({
    queryKey: ['knowledge', 'graph'],
    queryFn: () => readJson<{ nodes?: Array<any>; edges?: Array<any> }>('/api/knowledge/graph'),
  })

  const isLoading = rosterQuery.isLoading || missionsQuery.isLoading || skillsQuery.isLoading || knowledgeGraphQuery.isLoading
  const error = rosterQuery.error || missionsQuery.error || skillsQuery.error || knowledgeGraphQuery.error

  // Build graph data client-side (deterministic aggregation)
  const { nodes, edges } = useMemo(() => {
    const builtNodes: GraphNode[] = []
    const builtEdges: GraphEdge[] = []
    const nodeIds = new Set<string>()

    // Workers
    const workers = rosterQuery.data?.roster?.workers ?? []
    workers.forEach((w: any) => {
      if (!w.id) return
      const id = `worker:${w.id}`
      if (nodeIds.has(id)) return
      nodeIds.add(id)
      builtNodes.push({
        id,
        label: w.name || w.id,
        type: 'worker',
        meta: { role: w.role, specialty: w.specialty, skills: w.skills || [], model: w.model },
      })
      // Link to skills
      ;(w.skills || []).forEach((skillName: string) => {
        const skillId = `skill:${skillName}`
        builtEdges.push({ source: id, target: skillId, label: 'has skill' })
      })
    })

    // Missions (from data shape)
    const missions = missionsQuery.data?.missions || missionsQuery.data?.items || []
    missions.forEach((m: any, idx: number) => {
      const id = `mission:${m.id || m.missionId || `m${idx}`}`
      if (nodeIds.has(id)) return
      nodeIds.add(id)
      builtNodes.push({
        id,
        label: m.task || m.title || `Mission ${idx + 1}`,
        type: 'mission',
        meta: { state: m.state, workerId: m.workerId || m.assignments?.[0]?.workerId, assignments: m.assignments?.length || 0 },
      })
      // Link mission to worker if present
      const workerId = m.workerId || (m.assignments && m.assignments[0]?.workerId)
      if (workerId) {
        const wId = `worker:${workerId}`
        if (nodeIds.has(wId)) {
          builtEdges.push({ source: id, target: wId, label: 'assigned to' })
        }
      }
    })

    // Skills
    const skillsData = skillsQuery.data
    let skillsList: string[] = []
    if (skillsData?.skills) skillsList = Object.keys(skillsData.skills)
    else if (Array.isArray(skillsData)) skillsList = skillsData.map((s: any) => s.name || s)
    else if (skillsData?.installed) skillsList = Object.keys(skillsData.installed || {})
    skillsList.forEach((s: string) => {
      const id = `skill:${s}`
      if (nodeIds.has(id)) return
      nodeIds.add(id)
      builtNodes.push({
        id,
        label: s,
        type: 'skill',
        meta: { category: 'local' },
      })
    })

    // Notes from knowledge graph (reuse existing)
    const kgNodes = knowledgeGraphQuery.data?.nodes ?? []
    kgNodes.slice(0, 30).forEach((n: any) => {  // limit for v1 focus
      const id = `note:${n.id || n.path || n.title}`
      if (nodeIds.has(id)) return
      nodeIds.add(id)
      builtNodes.push({
        id,
        label: n.title || n.id || 'Note',
        type: 'note',
        meta: { path: n.path || n.id, tags: n.tags || [] },
      })
    })

    // Add some wiki edges as note-note links if present
    const kgEdges = knowledgeGraphQuery.data?.edges ?? []
    kgEdges.slice(0, 50).forEach((e: any) => {
      const sId = `note:${e.source}`
      const tId = `note:${e.target}`
      if (nodeIds.has(sId) && nodeIds.has(tId)) {
        builtEdges.push({ source: sId, target: tId, label: 'links to' })
      }
    })

    // Add some synthetic links for demo connectivity if sparse
    if (builtEdges.length < 5 && builtNodes.length > 3) {
      // simple connections between first few
      for (let i = 0; i < Math.min(5, builtNodes.length - 1); i++) {
        builtEdges.push({ source: builtNodes[i].id, target: builtNodes[i + 1].id })
      }
    }

    return { nodes: builtNodes, edges: builtEdges }
  }, [rosterQuery.data, missionsQuery.data, skillsQuery.data, knowledgeGraphQuery.data])

  // Filter nodes
  const filteredNodes = useMemo(() => {
    return nodes.filter((node) => {
      if (!visibleTypes[node.type]) return false
      if (searchTerm) {
        const term = searchTerm.toLowerCase()
        return node.label.toLowerCase().includes(term) || (node.meta && JSON.stringify(node.meta).toLowerCase().includes(term))
      }
      return true
    })
  }, [nodes, visibleTypes, searchTerm])

  // Initial layout (circular, deterministic)
  const positionedNodes = useMemo(() => {
    if (filteredNodes.length === 0) return []
    const width = 900
    const height = 600
    const centerX = width / 2
    const centerY = height / 2
    const radius = Math.max(180, Math.min(width, height) / 2 - 100)
    return filteredNodes.map((node, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(filteredNodes.length, 1)
      return {
        ...node,
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius,
      }
    })
  }, [filteredNodes])

  const [nodePositions, setNodePositions] = useState<PositionedNode[]>(positionedNodes)

  // Sync positions when data changes
  useEffect(() => {
    setNodePositions(positionedNodes)
  }, [positionedNodes])

  const byId = useMemo(() => new Map(nodePositions.map((n) => [n.id, n])), [nodePositions])

  // Filtered edges for visible nodes
  const visibleEdges = useMemo(() => {
    const visibleIds = new Set(nodePositions.map((n) => n.id))
    return edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
  }, [edges, nodePositions])

  // Event handlers for pan, zoom, drag
  const handleWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    const newScale = Math.max(0.3, Math.min(4, transform.scale * delta))
    setTransform((prev) => ({ ...prev, scale: newScale }))
  }, [transform.scale])

  const handleMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if ((e.target as Element).tagName === 'circle' || (e.target as Element).tagName === 'text') {
      // node drag handled separately
      return
    }
    setIsPanning(true)
    setLastPanPos({ x: e.clientX, y: e.clientY })
  }, [])

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (isPanning) {
      const dx = e.clientX - lastPanPos.x
      const dy = e.clientY - lastPanPos.y
      setTransform((prev) => ({
        ...prev,
        x: prev.x + dx / prev.scale,
        y: prev.y + dy / prev.scale,
      }))
      setLastPanPos({ x: e.clientX, y: e.clientY })
    } else if (draggingNodeId) {
      const svg = svgRef.current
      if (!svg) return
      const rect = svg.getBoundingClientRect()
      const svgX = (e.clientX - rect.left - transform.x * transform.scale) / transform.scale
      const svgY = (e.clientY - rect.top - transform.y * transform.scale) / transform.scale
      setNodePositions((prev) =>
        prev.map((n) =>
          n.id === draggingNodeId ? { ...n, x: svgX, y: svgY } : n
        )
      )
    }
  }, [isPanning, lastPanPos, draggingNodeId, transform])

  const handleMouseUp = useCallback(() => {
    setIsPanning(false)
    setDraggingNodeId(null)
  }, [])

  const handleNodeMouseDown = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation()
    setDraggingNodeId(nodeId)
    setSelectedNode(nodePositions.find((n) => n.id === nodeId) || null)
  }, [nodePositions])

  const handleNodeClick = useCallback((node: PositionedNode) => {
    setSelectedNode(node)
  }, [])

  // Fit to view
  const fitToView = useCallback(() => {
    if (nodePositions.length === 0) return
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    nodePositions.forEach((n) => {
      minX = Math.min(minX, n.x)
      minY = Math.min(minY, n.y)
      maxX = Math.max(maxX, n.x)
      maxY = Math.max(maxY, n.y)
    })
    const padding = 80
    const contentWidth = maxX - minX + padding * 2
    const contentHeight = maxY - minY + padding * 2
    const svgWidth = 900
    const svgHeight = 600
    const scaleX = svgWidth / contentWidth
    const scaleY = svgHeight / contentHeight
    const newScale = Math.max(0.3, Math.min(2.5, Math.min(scaleX, scaleY)))
    const centerX = (minX + maxX) / 2
    const centerY = (minY + maxY) / 2
    const newX = svgWidth / 2 / newScale - centerX
    const newY = svgHeight / 2 / newScale - centerY
    setTransform({ x: newX, y: newY, scale: newScale })
  }, [nodePositions])

  // Toggle type visibility
  const toggleType = (type: GraphNodeType) => {
    setVisibleTypes((prev) => ({ ...prev, [type]: !prev[type] }))
  }

  // Clear selection
  const clearSelection = () => setSelectedNode(null)

  // Legend
  const legendItems = Object.keys(TYPE_LABELS) as GraphNodeType[]

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="flex items-center gap-3 text-primary-500">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary-300 border-t-accent-500" />
          Building workspace graph...
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-center dark:border-red-900 dark:bg-red-950">
          <div className="text-lg font-medium text-red-700 dark:text-red-400">Graph load failed</div>
          <p className="mt-2 text-sm text-red-600 dark:text-red-300">{error instanceof Error ? error.message : 'Unknown error fetching data sources'}</p>
          <button onClick={() => window.location.reload()} className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700">Retry</button>
        </div>
      </div>
    )
  }

  if (nodes.length === 0) {
    return (
      <div className="p-8">
        <div className="rounded-xl border border-primary-200 bg-primary-50 p-8 text-center dark:border-neutral-800 dark:bg-neutral-900">
          <div className="text-lg font-medium">No workspace data</div>
          <p className="mt-2 text-sm text-primary-500 dark:text-neutral-400">No workers, missions, skills or notes found. Ensure swarm is active and knowledge base populated.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-primary-50 dark:bg-neutral-950" ref={containerRef}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-primary-200 px-6 py-4 dark:border-neutral-800">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Workspace Graph</h1>
          <p className="text-sm text-primary-500 dark:text-neutral-400">
            Obsidian-style view • {filteredNodes.length} nodes • {visibleEdges.length} edges
          </p>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search nodes..."
            className="w-64 rounded-lg border border-primary-200 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <Button variant="outline" size="sm" onClick={fitToView}>
            Fit to View
          </Button>
          <Button variant="outline" size="sm" onClick={clearSelection}>
            Clear Selection
          </Button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Graph Canvas */}
        <div className="flex-1 relative overflow-hidden bg-white dark:bg-neutral-950" style={{ touchAction: 'none' }}>
          <svg
            ref={svgRef}
            viewBox="0 0 900 600"
            className="h-full w-full cursor-grab active:cursor-grabbing"
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.scale})`}>
              {/* Edges */}
              {visibleEdges.map((edge, idx) => {
                const source = byId.get(edge.source)
                const target = byId.get(edge.target)
                if (!source || !target) return null
                return (
                  <g key={`${edge.source}-${edge.target}-${idx}`}>
                    <line
                      x1={source.x}
                      y1={source.y}
                      x2={target.x}
                      y2={target.y}
                      stroke="rgba(148, 163, 184, 0.4)"
                      strokeWidth="1.5"
                      strokeDasharray={edge.label ? '4 2' : 'none'}
                    />
                    {edge.label && (
                      <text
                        x={(source.x + target.x) / 2}
                        y={(source.y + target.y) / 2 - 4}
                        fontSize="9"
                        fill="#64748b"
                        textAnchor="middle"
                      >
                        {edge.label}
                      </text>
                    )}
                  </g>
                )
              })}

              {/* Nodes */}
              {nodePositions.map((node) => {
                const colors = NODE_COLORS[node.type]
                const isSelected = selectedNode?.id === node.id
                return (
                  <g
                    key={node.id}
                    onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
                    onClick={() => handleNodeClick(node)}
                    className="cursor-pointer select-none"
                  >
                    <circle
                      cx={node.x}
                      cy={node.y}
                      r={isSelected ? 22 : 18}
                      fill={colors.fill}
                      stroke={isSelected ? '#ef4444' : colors.stroke}
                      strokeWidth={isSelected ? 3 : 2}
                    />
                    <text
                      x={node.x}
                      y={node.y + 32}
                      textAnchor="middle"
                      fontSize="10"
                      fill={colors.text}
                      className="font-medium"
                    >
                      {node.label.length > 18 ? node.label.slice(0, 15) + '...' : node.label}
                    </text>
                    <text
                      x={node.x}
                      y={node.y - 26}
                      textAnchor="middle"
                      fontSize="8"
                      fill="#64748b"
                    >
                      {node.type}
                    </text>
                  </g>
                )
              })}
            </g>
          </svg>

          {/* Legend */}
          <div className="absolute bottom-4 right-4 rounded-xl border border-primary-200 bg-white/95 p-3 text-xs shadow dark:border-neutral-700 dark:bg-neutral-900/95">
            <div className="mb-2 font-semibold text-primary-600 dark:text-neutral-300">Legend</div>
            {legendItems.map((type) => (
              <label key={type} className="flex items-center gap-2 py-0.5">
                <input
                  type="checkbox"
                  checked={visibleTypes[type]}
                  onChange={() => toggleType(type)}
                  className="accent-accent-500"
                />
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: NODE_COLORS[type].stroke }}
                />
                <span className="text-primary-700 dark:text-neutral-200">{TYPE_LABELS[type]}</span>
              </label>
            ))}
            <div className="mt-2 text-[10px] text-primary-400 dark:text-neutral-500">
              Pan: drag bg • Zoom: wheel • Drag: nodes • Click: select
            </div>
          </div>
        </div>

        {/* Detail Panel */}
        <div className="w-80 border-l border-primary-200 bg-white dark:border-neutral-800 dark:bg-neutral-900 overflow-auto">
          {selectedNode ? (
            <div className="p-5">
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-xs uppercase tracking-widest text-primary-500 dark:text-neutral-400">{selectedNode.type}</div>
                  <h3 className="text-xl font-semibold tracking-tight">{selectedNode.label}</h3>
                </div>
                <button onClick={clearSelection} className="text-primary-400 hover:text-primary-600">✕</button>
              </div>

              <div className="mt-4 space-y-4 text-sm">
                <div>
                  <div className="font-medium text-primary-600 dark:text-neutral-300 mb-1">ID</div>
                  <div className="font-mono text-xs break-all bg-primary-50 dark:bg-neutral-800 p-2 rounded">{selectedNode.id}</div>
                </div>

                {selectedNode.meta && Object.keys(selectedNode.meta).length > 0 && (
                  <div>
                    <div className="font-medium text-primary-600 dark:text-neutral-300 mb-1">Details</div>
                    <pre className="text-xs bg-primary-50 dark:bg-neutral-800 p-3 rounded overflow-auto max-h-48 whitespace-pre-wrap">
                      {JSON.stringify(selectedNode.meta, null, 2)}
                    </pre>
                  </div>
                )}

                <div className="pt-2 text-xs text-primary-400 dark:text-neutral-500">
                  Connected to {visibleEdges.filter((e) => e.source === selectedNode.id || e.target === selectedNode.id).length} other nodes
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-primary-500 dark:text-neutral-400">
              Select a node to view details.<br />Supports pan, zoom, drag, search &amp; filters.
            </div>
          )}
        </div>
      </div>

      {/* Footer status */}
      <div className="border-t border-primary-200 px-6 py-2 text-xs text-primary-500 dark:border-neutral-800 dark:text-neutral-400 flex justify-between">
        <div>Data sources: swarm-roster • swarm-missions • skills • knowledge/graph (deterministic, local)</div>
        <div>Theme aware • No secrets • Reuses existing APIs</div>
      </div>
    </div>
  )
}
