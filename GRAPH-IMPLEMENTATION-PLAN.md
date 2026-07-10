# Short Implementation Plan: Obsidian-style Interactive Graph View

## Inspection Summary (Completed)
- **UI/Routing**: TanStack Router (routeTree.gen.ts, router.tsx, __root.tsx). Routes in src/routes/ (e.g. conductor.tsx, memory.tsx, dashboard.tsx, skills.tsx, swarm.tsx). WorkspaceShell wraps content. Themes via data-theme and class dark/light in styles.css/scifi-theme.css.
- **Styling System**: Tailwind-like utility classes, CSS vars for themes (dark: #0A0E1A etc.), components in src/components/ui/, modals use DialogRoot (likely Radix or custom). Reusable: StateBox, empty-state, loading-indicator, cards, panels.
- **Dashboard Components**: dashboard-screen.tsx uses cards, lists, QueryClient. Swarm/memory screens use useQuery for data. Existing basic GraphCanvas in knowledge-browser-screen.tsx (static radial SVG, no pan/zoom/drag).
- **Data APIs (local/deterministic)**: 
  - /api/knowledge/graph (buildKnowledgeGraph in server/knowledge-browser.ts) - wiki pages + wikilinks.
  - /api/skills (filesystem ~/.hermes/skills or HERMES_SKILLS_DIR, categories/skills).
  - swarm-roster.ts, swarm-missions.ts, swarm-memory.ts (filesystem backed missions, workers, handoffs, episodes).
  - memory/ dir in workspace for swarm state (handoffs, PROJECT.md).
  - No secrets exposed.
- **Existing Patterns**: useQuery for data, SVG for viz, Dialog for overlays, side panels for details, filters with state, theme-aware classes. Reuse QueryClient, cn() utils, icons from hugeicons or lucide.
- **Dependencies**: No new ones; pure React + SVG + native events for interactivity. Avoid external graph libs.

## Identified Exact Files/Routes/Components to Change/Add
- **New Route**: src/routes/graph.tsx (new file) - file route for /graph
- **New Screen**: src/screens/graph/graph-screen.tsx (new) or integrate; main interactive view.
- **New Component**: src/components/graph/WorkspaceGraph.tsx (new dir) - core interactive SVG/canvas with pan/zoom/drag, types.
- **Data Layer**: src/server/workspace-graph.ts (new) - buildWorkspaceGraph() aggregating workers, missions, skills, notes (from memory/knowledge), deterministic links (e.g. mission-worker, skill-category, wiki edges). Or extend knowledge-browser.ts.
- **API Route**: src/routes/api/workspace/graph.ts (new) - GET handler using the build fn, authenticated.
- **Update Knowledge Browser?**: Optional reuse GraphCanvas but replace/enhance with new interactive one for consistency; or keep separate.
- **Routing Update**: Auto via routeTree.gen.ts (will regenerate on build/dev?); no manual edit.
- **Tests**: src/screens/graph/graph-screen.test.tsx (new focused), update existing if needed.
- **Handoff Note**: Create concise note in memory/handoffs/ or /root/hermes-workspace/memory/handoffs/swarm/librarian-latest.md
- **No Changes**: No auth, no new deps, no break dashboard/chat/kanban/swarm, no secrets.

## Implementation Approach (Focused v1)
- Data model: Nodes {id, label, type: 'worker'|'mission'|'skill'|'note'|'link', meta}, Edges {source, target, type?}.
- Viz: SVG with viewBox, React state for transform (pan/zoom via wheel/drag), node positions draggable (mouse events), fit-to-view button.
- Interactions: Click node -> detail panel (right side, type-specific info like mission status, skill desc). Search input filters nodes. Type checkboxes toggle visibility. Legend with colors (worker: blue, mission: green, skill: purple, note: amber).
- States: Loading (spinner), Empty (no data msg), Error (retry).
- Themes: Use currentColor, dark: neutral tones, light: adjusted.
- Performance: Memo layouts, limit nodes for v1 (~50-100).
- Reuse: useQuery, Dialog if modal, WorkspaceShell patterns, existing icons.
- After: Add focused tests (vitest), run `pnpm test` or specific, verification report.
- Keep minimal: No 3D, no force sim if complex (simple force or manual layout), deterministic static layout + drag.

## Next Steps After Plan
Implement changes, test, verify, produce handoff note, checkpoint.

This plan reuses all existing patterns, focuses on maintainable core graph for workspace entities.