// Quick-route buttons in the router chat prefill prompts like
// "Use the research specialist for this:" — if dispatched unedited there is
// no actual task. Reject anything that is just a routing preamble ending in
// a colon with nothing of substance after it. See the 2026-07-07 triple
// "empty task" incident (researcher/orchestrator/workspace all blocked).
//
// Shared between the server-side dispatch guard (src/routes/api/swarm-dispatch.ts)
// and the router chat UI (src/components/swarm/router-chat.tsx) so both use the
// exact same predicate.
export function isBareTemplateTask(task: string): boolean {
  const trimmed = task.trim()
  if (!trimmed) return true
  const templateMatch = /^use the [\w\s/-]+ specialist for this:?$/i.test(trimmed)
  if (templateMatch) return true
  // Generic guard: a single short line ending in ":" carries no task body.
  return trimmed.length <= 80 && !trimmed.includes('\n') && trimmed.endsWith(':')
}
