import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import { cn } from '@/lib/utils'

export type GraphNode = {
  id: string
  title: string
  type?: string
  tags?: string[]
  summary?: string
}

export type GraphEdge = {
  source: string
  target: string
}

interface InteractiveGraphProps {
  nodes: GraphNode[]
  edges: GraphEdge[]
  onNodeSelect?: (node: GraphNode) => void
  className?: string
  height?: number
}

const NODE_COLORS: Record<string, string> = {
  note: '#3b82f6',
  skill: '#22c55e',
  mission: '#f59e0b',
  worker: '#8b5cf6',
  default: '#64748b',
}

const NODE_LABELS: Record<string, string> = {
  note: 'Note',
  skill: 'Skill',
  mission: 'Mission',
  worker: 'Worker',
}

export function InteractiveGraph({
  nodes: initialNodes,
  edges: initialEdges,
  onNodeSelect,
  className,
  height = 600,
}: InteractiveGraphProps) {
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(() => {
    const map = new Map<string, { x: number; y: number }>()
    if (initialNodes.length === 0) return map
    const w = 1200
    const h = height
    const cx = w / 2
    const cy = h / 2
    const r = Math.min(w, h) / 2 - 80
    initialNodes.forEach((node, i) => {
      const angle = (Math.PI * 2 * i) / initialNodes.length
      map.set(node.id, {
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r,
      })
    })
    return map
  })

  const [transform, setTransform] = useState({ scale: 1, tx: 0, ty: 0 })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set(Object.keys(NODE_COLORS).filter(k => k !== 'default')))
  const [isPanning, setIsPanning] = useState(false)
  const [dragNodeId, setDragNodeId] = useState<string | null>(null)
  const [lastPos, setLastPos] = useState({ x: 0, y: 0 })

  const svgRef = useRef<SVGSVGElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const filteredNodes = useMemo(() => {
    return initialNodes
      .filter((node) => {
        const type = node.type || 'note'
        const matchesType = activeTypes.has(type)
        const matchesSearch = !searchTerm || 
          node.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
          (node.tags || []).some(t => t.toLowerCase().includes(searchTerm.toLowerCase()))
        return matchesType && matchesSearch
      })
      .map((node) => ({
        ...node,
        pos: positions.get(node.id) || { x: 400, y: 300 },
      }))
  }, [initialNodes, activeTypes, searchTerm, positions])

  const filteredEdges = useMemo(() => {
    const visibleIds = new Set(filteredNodes.map(n => n.id))
    return initialEdges.filter(e => visibleIds.has(e.source) && visibleIds.has(e.target))
  }, [initialEdges, filteredNodes])

  const selectedNode = useMemo(() => 
    initialNodes.find(n => n.id === selectedId) || null
  , [initialNodes, selectedId])

  const toggleType = (type: string) => {
    const next = new Set(activeTypes)
    if (next.has(type)) {
      next.delete(type)
    } else {
      next.add(type)
    }
    setActiveTypes(next)
  }

  const resetView = useCallback(() => {
    setTransform({ scale: 1, tx: 0, ty: 0 })
    // re-seed positions if needed
    const map = new Map<string, { x: number; y: number }>()
    if (initialNodes.length > 0) {
      const w = 1200
      const h = height
      const cx = w / 2
      const cy = h / 2
      const r = Math.min(w, h) / 2 - 80
      initialNodes.forEach((node, i) => {
        const angle = (Math.PI * 2 * i) / initialNodes.length
        map.set(node.id, {
          x: cx + Math.cos(angle) * r,
          y: cy + Math.sin(angle) * r,
        })
      })
    }
    setPositions(map)
    setSelectedId(null)
    setSearchTerm('')
  }, [initialNodes, height])

  const fitToView = useCallback(() => {
    if (filteredNodes.length === 0) return
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    filteredNodes.forEach(n => {
      const p = n.pos
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    })
    const padding = 80
    const contentW = maxX - minX + padding * 2
    const contentH = maxY - minY + padding * 2
    const svgW = 1200
    const svgH = height
    const scaleX = svgW / contentW
    const scaleY = svgH / contentH
    const newScale = Math.max(0.3, Math.min(3, Math.min(scaleX, scaleY)))
    const centerX = (minX + maxX) / 2
    const centerY = (minY + maxY) / 2
    const newTx = svgW / 2 - centerX * newScale
    const newTy = svgH / 2 - centerY * newScale
    setTransform({ scale: newScale, tx: newTx, ty: newTy })
  }, [filteredNodes, height])

  // Wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault()
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const mouseX = e.clientX - rect.left
    const mouseY = e.clientY - rect.top
    const delta = e.deltaY > 0 ? 0.85 : 1.18
    const newScale = Math.max(0.2, Math.min(6, transform.scale * delta))
    
    // Zoom towards mouse
    const worldX = (mouseX - transform.tx) / transform.scale
    const worldY = (mouseY - transform.ty) / transform.scale
    const newTx = mouseX - worldX * newScale
    const newTy = mouseY - worldY * newScale
    
    setTransform({ scale: newScale, tx: newTx, ty: newTy })
  }, [transform])

  // Pan and drag logic
  const handlePointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const clientX = e.clientX - rect.left
    const clientY = e.clientY - rect.top

    // Check if clicking on a node (simple hit test)
    let hitNode: string | null = null
    const scale = transform.scale
    const tx = transform.tx
    const ty = transform.ty

    for (const node of filteredNodes) {
      const nx = node.pos.x * scale + tx
      const ny = node.pos.y * scale + ty
      const dist = Math.hypot(nx - clientX, ny - clientY)
      if (dist < 28 * scale) {
        hitNode = node.id
        break
      }
    }

    if (hitNode) {
      setDragNodeId(hitNode)
      setSelectedId(hitNode)
      const nodePos = positions.get(hitNode) || { x: 0, y: 0 }
      setLastPos({ x: clientX, y: clientY })
      if (onNodeSelect) {
        const fullNode = initialNodes.find(n => n.id === hitNode)
        if (fullNode) onNodeSelect(fullNode)
      }
    } else {
      // Pan background
      setIsPanning(true)
      setLastPos({ x: clientX, y: clientY })
      setSelectedId(null)
    }
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }, [transform, filteredNodes, positions, initialNodes, onNodeSelect])

  const handlePointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const clientX = e.clientX - rect.left
    const clientY = e.clientY - rect.top
    const dx = clientX - lastPos.x
    const dy = clientY - lastPos.y

    if (dragNodeId) {
      // Drag node - convert screen delta to world
      const worldDx = dx / transform.scale
      const worldDy = dy / transform.scale
      setPositions(prev => {
        const next = new Map(prev)
        const current = next.get(dragNodeId) || { x: 400, y: 300 }
        next.set(dragNodeId, {
          x: current.x + worldDx,
          y: current.y + worldDy,
        })
        return next
      })
      setLastPos({ x: clientX, y: clientY })
    } else if (isPanning) {
      setTransform(prev => ({
        ...prev,
        tx: prev.tx + dx,
        ty: prev.ty + dy,
      }))
      setLastPos({ x: clientX, y: clientY })
    }
  }, [dragNodeId, isPanning, lastPos, transform.scale])

  const handlePointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    setIsPanning(false)
    setDragNodeId(null)
    ;(e.target as Element).releasePointerCapture(e.pointerId)
  }, [])

  // Double click to fit or reset
  const handleDoubleClick = useCallback(() => {
    fitToView()
  }, [fitToView])

  const handleNodeClick = useCallback((nodeId: string) => {
    setSelectedId(nodeId)
    const node = initialNodes.find(n => n.id === nodeId)
    if (node && onNodeSelect) onNodeSelect(node)
  }, [initialNodes, onNodeSelect])

  // Keyboard support for search focus etc, but simple

  const allTypes = useMemo(() => {
    const types = new Set<string>()
    initialNodes.forEach(n => types.add(n.type || 'note'))
    return Array.from(types)
  }, [initialNodes])

  if (initialNodes.length === 0) {
    return (
      <div className="flex h-[600px] items-center justify-center rounded-2xl border border-primary-200 bg-primary-50 dark:border-neutral-800 dark:bg-neutral-950 text-sm text-primary-500 dark:text-neutral-400">
        No graph data available
      </div>
    )
  }

  return (
    <div className={cn("flex flex-col gap-3", className)} ref={containerRef}>
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 px-1">
        <div className="flex items-center gap-1.5 rounded-lg border border-primary-200 bg-white px-2 py-1 dark:border-neutral-800 dark:bg-neutral-950">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search nodes or tags..."
            className="w-48 bg-transparent text-sm outline-none placeholder:text-primary-400 dark:placeholder:text-neutral-500"
          />
        </div>

        <div className="flex items-center gap-1">
          {allTypes.map((type) => {
            const color = NODE_COLORS[type] || NODE_COLORS.default
            const isActive = activeTypes.has(type)
            return (
              <button
                key={type}
                onClick={() => toggleType(type)}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all",
                  isActive 
                    ? "border-primary-300 bg-primary-100 text-primary-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200" 
                    : "border-primary-200 bg-white text-primary-400 opacity-60 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-500"
                )}
                style={{ borderColor: isActive ? color : undefined }}
              >
                <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                {NODE_LABELS[type] || type}
              </button>
            )
          })}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={fitToView}
            className="rounded-lg border border-primary-200 bg-white px-3 py-1.5 text-xs font-medium text-primary-600 hover:bg-primary-50 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-900"
          >
            Fit to view
          </button>
          <button
            onClick={resetView}
            className="rounded-lg border border-primary-200 bg-white px-3 py-1.5 text-xs font-medium text-primary-600 hover:bg-primary-50 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-900"
          >
            Reset
          </button>
        </div>
      </div>

      <div className="flex flex-1 gap-3 min-h-0">
        {/* Graph Canvas */}
        <div className="relative flex-1 overflow-hidden rounded-2xl border border-primary-200 bg-primary-50 dark:border-neutral-800 dark:bg-neutral-950">
          <svg
            ref={svgRef}
            width="100%"
            height={height}
            viewBox="0 0 1200 600"
            className="touch-none select-none"
            onWheel={handleWheel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            onDoubleClick={handleDoubleClick}
          >
            <g
              transform={`translate(${transform.tx} ${transform.ty}) scale(${transform.scale})`}
            >
              {/* Edges */}
              {filteredEdges.map((edge, idx) => {
                const source = filteredNodes.find(n => n.id === edge.source)
                const target = filteredNodes.find(n => n.id === edge.target)
                if (!source || !target) return null
                return (
                  <line
                    key={`${edge.source}-${edge.target}-${idx}`}
                    x1={source.pos.x}
                    y1={source.pos.y}
                    x2={target.pos.x}
                    y2={target.pos.y}
                    stroke="rgba(148, 163, 184, 0.35)"
                    strokeWidth="1.5"
                  />
                )
              })}

              {/* Nodes */}
              {filteredNodes.map((node) => {
                const color = NODE_COLORS[node.type || 'note'] || NODE_COLORS.default
                const isSelected = node.id === selectedId
                const isDimmed = searchTerm && !node.title.toLowerCase().includes(searchTerm.toLowerCase())
                return (
                  <g
                    key={node.id}
                    onClick={() => handleNodeClick(node.id)}
                    className="cursor-pointer"
                    style={{ opacity: isDimmed ? 0.4 : 1 }}
                  >
                    <circle
                      cx={node.pos.x}
                      cy={node.pos.y}
                      r={isSelected ? 22 : 18}
                      fill={color}
                      fillOpacity={isSelected ? 0.25 : 0.15}
                      stroke={color}
                      strokeWidth={isSelected ? 3 : 2}
                      strokeOpacity={0.9}
                    />
                    <text
                      x={node.pos.x}
                      y={node.pos.y + 38}
                      textAnchor="middle"
                      fontSize="10"
                      fill="currentColor"
                      className="pointer-events-none select-none font-medium"
                    >
                      {node.title.length > 18 ? node.title.slice(0, 15) + '...' : node.title}
                    </text>
                    <text
                      x={node.pos.x}
                      y={node.pos.y - 28}
                      textAnchor="middle"
                      fontSize="8"
                      fill={color}
                      className="pointer-events-none select-none uppercase tracking-[1px]"
                    >
                      {node.type || 'note'}
                    </text>
                  </g>
                )
              })}
            </g>
          </svg>

          {/* Legend overlay */}
          <div className="absolute bottom-3 right-3 rounded-xl border border-primary-200 bg-white/90 px-3 py-2 text-xs shadow-sm backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/90">
            <div className="mb-1 text-[10px] font-medium text-primary-500 dark:text-neutral-400">Legend</div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5">
              {Object.entries(NODE_COLORS).filter(([k]) => k !== 'default').map(([type, color]) => (
                <div key={type} className="flex items-center gap-1 text-primary-600 dark:text-neutral-300">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                  <span>{NODE_LABELS[type] || type}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Instructions */}
          <div className="absolute top-3 left-3 rounded-lg bg-white/80 px-2.5 py-1 text-[10px] text-primary-500 dark:bg-neutral-950/80 dark:text-neutral-400">
            Drag nodes • Pan background • Scroll to zoom • Double-click to fit
          </div>
        </div>

        {/* Detail Panel */}
        <div className="w-72 flex-shrink-0 rounded-2xl border border-primary-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950 overflow-auto">
          {selectedNode ? (
            <div>
              <div className="mb-3 flex items-center gap-2">
                <span 
                  className="inline-block h-3 w-3 rounded-full" 
                  style={{ backgroundColor: NODE_COLORS[selectedNode.type || 'note'] }} 
                />
                <span className="text-xs uppercase tracking-widest text-primary-500 dark:text-neutral-400">
                  {NODE_LABELS[selectedNode.type || 'note'] || selectedNode.type}
                </span>
              </div>
              <h3 className="text-lg font-semibold text-primary-950 dark:text-white break-words">
                {selectedNode.title}
              </h3>
              {selectedNode.tags && selectedNode.tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {selectedNode.tags.slice(0, 6).map(tag => (
                    <span key={tag} className="rounded-full bg-primary-100 px-2 py-0.5 text-xs text-primary-600 dark:bg-neutral-900 dark:text-neutral-300">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              {selectedNode.summary && (
                <p className="mt-3 text-sm text-primary-600 dark:text-neutral-400 leading-relaxed">
                  {selectedNode.summary}
                </p>
              )}
              <div className="mt-4 text-[10px] text-primary-400 dark:text-neutral-500">
                ID: {selectedNode.id}
              </div>
              <button 
                onClick={() => setSelectedId(null)} 
                className="mt-4 text-xs text-primary-500 hover:text-primary-600 dark:text-neutral-400"
              >
                Close detail
              </button>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center text-center text-sm text-primary-400 dark:text-neutral-500">
              <div className="mb-2 text-4xl opacity-30">⊚</div>
              <p>Select a node to view details</p>
              <p className="mt-1 text-xs">Click any circle in the graph</p>
            </div>
          )}
        </div>
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between px-1 text-xs text-primary-400 dark:text-neutral-500">
        <div>
          {filteredNodes.length} nodes • {filteredEdges.length} edges
          {searchTerm && ` • filtered by "${searchTerm}"`}
        </div>
        <div>Scale: {transform.scale.toFixed(2)}x</div>
      </div>
    </div>
  )
}
