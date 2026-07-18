import { useCallback, useEffect, useState } from 'react'
import { Markdown } from '@/components/prompt-kit/markdown'
import { Button } from '@/components/ui/button'
import { usePageTitle } from '@/hooks/use-page-title'

export type OsintCaseOverview = {
  case_id: string
  state: string
  question: string
  created_utc: string
  updated_utc: string
  finding_count: number
  substantive_count: number
}

type SafeRecord = Record<string, unknown>

type EvidenceFinding = SafeRecord & {
  citation_id: string
  finding_id?: string
  round_id: string
  evidence_role: string
  tool: string
  tool_version: string
  source_url_or_record_id: string
  collected_utc: string
  method: string
  bytes: number
  mime: string
  sha256: string
  status: string
  egress_class: string
  confidence: string
  confidence_reason: string
  parent_finding_ids: Array<string>
  normalized_result?: SafeRecord
}

type CollectionPlanItem = {
  adapter: string
  input_type: string
  egress_class: string
  heavy: boolean
  classification: string
  reason: string
}

export type OsintCaseDetail = {
  case: {
    case_id: string
    state: string
    created_utc: string
    updated_utc: string
    question: string
    authority: string
  }
  authorization: SafeRecord
  amendments: Array<SafeRecord>
  evidence: {
    counts_by_role: Record<string, number>
    counts_by_status: Record<string, number>
    counts_by_tool: Record<string, number>
    total: number
    omitted: number
    findings: Array<EvidenceFinding>
  }
  entities: { total: number; items: Array<SafeRecord> }
  relations: { total: number; items: Array<SafeRecord> }
  rounds: Array<SafeRecord>
  pivots: Array<SafeRecord>
  collection_plan: {
    limits: {
      timeout_seconds: number
      output_limit_bytes: number
      heavy_concurrency: number
    }
    adapters: Array<CollectionPlanItem>
  }
  report: null | {
    round_id: string
    sha256: string
    bytes: number
    filename: string
    markdown: string
  }
  integrity: {
    manifest_matches: boolean
    modified_count: number
    missing_count: number
    extra_count: number
  }
}

export type OsintActionInput =
  | {
      action: 'amendment-propose'
      caseId: string
      changes: Record<string, string | Array<string> | number>
      rationale: string
    }
  | {
      action: 'amendment-review'
      caseId: string
      amendmentId: string
      decision: 'APPROVED' | 'REJECTED'
      rationale: string
    }

const fieldClass =
  'w-full rounded-lg border border-[var(--theme-border)] bg-[var(--theme-bg)] px-3 py-2 text-sm text-[var(--theme-text)] outline-none focus:border-blue-500'

function countLabel(value: number, singular: string, plural = `${singular}s`) {
  return `${value} ${value === 1 ? singular : plural}`
}

function shortHash(value: unknown) {
  return typeof value === 'string' ? value.slice(0, 12) : 'unknown'
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—'
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}

function StateBadge({ value }: { value: unknown }) {
  return (
    <span className="rounded-full border border-[var(--theme-border)] bg-[var(--theme-bg-subtle)] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--theme-muted)]">
      {display(value)}
    </span>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg-elevated)] p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-[0.12em] text-[var(--theme-muted)]">
        {title}
      </h2>
      {children}
    </section>
  )
}

function RecordGrid({ items, empty }: { items: Array<SafeRecord>; empty: string }) {
  if (!items.length) return <p className="text-sm text-[var(--theme-muted)]">{empty}</p>
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {items.map((item, index) => (
        <article
          className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] p-3"
          key={String(item.amendment_id ?? item.entity_id ?? item.relation_id ?? item.round_id ?? item.proposal_id ?? index)}
        >
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <strong className="text-sm text-[var(--theme-text)]">
              {display(
                item.amendment_id ??
                  item.entity_id ??
                  item.relation_id ??
                  item.round_id ??
                  item.proposal_id ??
                  `Record ${index + 1}`,
              )}
            </strong>
            {(item.status || item.state || item.review_state) && (
              <StateBadge value={item.status ?? item.state ?? item.review_state} />
            )}
          </div>
          <dl className="space-y-1 text-xs">
            {Object.entries(item)
              .filter(
                ([key]) =>
                  ![
                    'amendment_id',
                    'entity_id',
                    'relation_id',
                    'round_id',
                    'proposal_id',
                    'status',
                    'state',
                    'review_state',
                  ].includes(key),
              )
              .map(([key, value]) => (
                <div className="grid grid-cols-[8rem_1fr] gap-2" key={key}>
                  <dt className="break-words text-[var(--theme-muted)]">{key.replaceAll('_', ' ')}</dt>
                  <dd className="min-w-0 whitespace-pre-wrap break-words text-[var(--theme-text)]">
                    {display(value)}
                  </dd>
                </div>
              ))}
          </dl>
        </article>
      ))}
    </div>
  )
}

export function OsintCaseListView({
  cases,
  selectedCaseId,
  onSelect,
}: {
  cases: Array<OsintCaseOverview>
  selectedCaseId: string | null
  onSelect: (caseId: string) => void
}) {
  if (!cases.length) {
    return <p className="p-4 text-sm text-[var(--theme-muted)]">No authorized cases found.</p>
  }
  return (
    <div className="space-y-2 p-2">
      {cases.map((item) => (
        <button
          className={`w-full rounded-xl border p-3 text-left transition ${
            selectedCaseId === item.case_id
              ? 'border-blue-500 bg-blue-500/10'
              : 'border-[var(--theme-border)] bg-[var(--theme-bg)] hover:bg-[var(--theme-bg-subtle)]'
          }`}
          key={item.case_id}
          onClick={() => onSelect(item.case_id)}
          type="button"
        >
          <div className="flex items-center justify-between gap-2">
            <strong className="truncate text-sm text-[var(--theme-text)]">{item.case_id}</strong>
            <StateBadge value={item.state} />
          </div>
          <p className="mt-2 line-clamp-2 text-xs text-[var(--theme-muted)]">{item.question}</p>
          <div className="mt-2 flex gap-3 text-[11px] text-[var(--theme-muted)]">
            <span>{countLabel(item.substantive_count, 'substantive')}</span>
            <span>{countLabel(item.finding_count, 'finding')}</span>
          </div>
        </button>
      ))}
    </div>
  )
}

function AmendmentControls({
  detail,
  pending,
  onAction,
}: {
  detail: OsintCaseDetail
  pending: boolean
  onAction: (action: OsintActionInput) => Promise<void>
}) {
  const [scope, setScope] = useState('')
  const [methods, setMethods] = useState('')
  const [egress, setEgress] = useState('')
  const [maxRounds, setMaxRounds] = useState('')
  const [proposalRationale, setProposalRationale] = useState('')
  const [reviewRationales, setReviewRationales] = useState<Record<string, string>>({})
  const pendingAmendments = detail.amendments.filter((item) => item.status === 'PENDING')

  const propose = (event: React.FormEvent) => {
    event.preventDefault()
    const changes: Record<string, string | Array<string> | number> = {}
    if (scope.trim()) changes.scope = scope.trim()
    if (methods.trim()) changes.methods = methods.split(',').map((item) => item.trim()).filter(Boolean)
    if (egress.trim()) changes.egress_approvals = egress.split(',').map((item) => item.trim()).filter(Boolean)
    if (maxRounds) changes.max_rounds = Number(maxRounds)
    if (!Object.keys(changes).length || !proposalRationale.trim()) return
    void onAction({
      action: 'amendment-propose',
      caseId: detail.case.case_id,
      changes,
      rationale: proposalRationale.trim(),
    })
  }

  const review = (amendmentId: string, decision: 'APPROVED' | 'REJECTED') => {
    const rationale = (reviewRationales[amendmentId] ?? '').trim()
    if (!rationale) return
    void onAction({
      action: 'amendment-review',
      caseId: detail.case.case_id,
      amendmentId,
      decision,
      rationale,
    })
  }

  return (
    <Section title="Authorization controls">
      <form className="grid gap-3" onSubmit={propose}>
        <h3 className="text-sm font-semibold text-[var(--theme-text)]">Propose authorization amendment</h3>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-xs text-[var(--theme-muted)]">
            Scope
            <textarea className={`${fieldClass} mt-1`} maxLength={4096} onChange={(event) => setScope(event.target.value)} value={scope} />
          </label>
          <label className="text-xs text-[var(--theme-muted)]">
            Methods (comma separated)
            <input className={`${fieldClass} mt-1`} onChange={(event) => setMethods(event.target.value)} value={methods} />
          </label>
          <label className="text-xs text-[var(--theme-muted)]">
            Egress approvals (comma separated)
            <input className={`${fieldClass} mt-1`} onChange={(event) => setEgress(event.target.value)} value={egress} />
          </label>
          <label className="text-xs text-[var(--theme-muted)]">
            Maximum rounds
            <input className={`${fieldClass} mt-1`} max={100} min={1} onChange={(event) => setMaxRounds(event.target.value)} type="number" value={maxRounds} />
          </label>
        </div>
        <label className="text-xs text-[var(--theme-muted)]">
          Proposal rationale
          <textarea className={`${fieldClass} mt-1`} maxLength={4096} onChange={(event) => setProposalRationale(event.target.value)} required value={proposalRationale} />
        </label>
        <div><Button disabled={pending} type="submit">Propose amendment</Button></div>
      </form>

      {pendingAmendments.length > 0 && (
        <div className="mt-6 space-y-3 border-t border-[var(--theme-border)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--theme-text)]">Pending semantic review</h3>
          {pendingAmendments.map((item) => {
            const amendmentId = String(item.amendment_id)
            return (
              <article className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3" key={amendmentId}>
                <div className="font-mono text-xs text-[var(--theme-text)]">{amendmentId}</div>
                <pre className="my-2 whitespace-pre-wrap text-xs text-[var(--theme-text)]">{display(item.changes)}</pre>
                <textarea
                  aria-label={`Review rationale for ${amendmentId}`}
                  className={fieldClass}
                  maxLength={4096}
                  onChange={(event) => setReviewRationales((current) => ({ ...current, [amendmentId]: event.target.value }))}
                  placeholder="Required approval or rejection rationale"
                  value={reviewRationales[amendmentId] ?? ''}
                />
                <div className="mt-3 flex gap-2">
                  <Button disabled={pending} onClick={() => review(amendmentId, 'APPROVED')} type="button">Approve amendment</Button>
                  <Button disabled={pending} onClick={() => review(amendmentId, 'REJECTED')} type="button" variant="outline">Reject amendment</Button>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </Section>
  )
}

export function OsintCaseDetailView({
  detail,
  onAction,
  actionPending = false,
}: {
  detail: OsintCaseDetail
  onAction?: (action: OsintActionInput) => Promise<void>
  actionPending?: boolean
}) {
  const roles = detail.evidence.counts_by_role
  const integrity = detail.integrity
  return (
    <div className="space-y-4 pb-10">
      <header className="rounded-2xl border border-[var(--theme-border)] bg-[var(--theme-bg-elevated)] p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-[var(--theme-text)]">{detail.case.case_id}</h1>
          <StateBadge value={detail.case.state} />
          <span className={`text-xs font-medium ${integrity.manifest_matches ? 'text-emerald-500' : 'text-red-500'}`}>
            {integrity.manifest_matches ? 'Manifest verified' : 'Manifest mismatch'}
          </span>
        </div>
        <p className="mt-3 text-base text-[var(--theme-text)]">{detail.case.question}</p>
        <p className="mt-2 text-xs text-[var(--theme-muted)]">Authority: {detail.case.authority}</p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ['Substantive', roles.SUBSTANTIVE],
          ['Coverage', roles.COVERAGE],
          ['Provenance only', roles.PROVENANCE_ONLY],
          ['Total evidence', detail.evidence.total],
        ].map(([label, value]) => (
          <div className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg-elevated)] p-4" key={label}>
            <div className="text-2xl font-semibold text-[var(--theme-text)]">{value}</div>
            <div className="text-xs uppercase tracking-wide text-[var(--theme-muted)]">{label}</div>
          </div>
        ))}
      </div>

      <Section title="Evidence findings">
        <div className="space-y-3">
          {detail.evidence.findings.map((finding) => (
            <article className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] p-4" key={finding.citation_id}>
              <div className="flex flex-wrap items-center gap-2">
                <strong className="font-mono text-sm text-blue-500">{finding.citation_id}</strong>
                <StateBadge value={finding.evidence_role} />
                <StateBadge value={finding.status} />
                <span className="text-xs text-[var(--theme-muted)]">{finding.tool} · {finding.confidence} confidence</span>
              </div>
              {finding.normalized_result && (
                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-lg bg-[var(--theme-bg-subtle)] p-3 text-xs text-[var(--theme-text)]">
                  {display(finding.normalized_result)}
                </pre>
              )}
              <p className="mt-3 text-sm text-[var(--theme-text)]">{finding.confidence_reason}</p>
              <div className="mt-3 grid gap-1 text-[11px] text-[var(--theme-muted)] sm:grid-cols-2">
                <span>Source: {finding.source_url_or_record_id}</span>
                <span>Round: {finding.round_id}</span>
                <span>SHA-256: <code>{shortHash(finding.sha256)}</code></span>
                <span>{finding.bytes.toLocaleString()} bytes · {finding.mime}</span>
              </div>
            </article>
          ))}
          {!detail.evidence.findings.length && <p className="text-sm text-[var(--theme-muted)]">No evidence findings recorded.</p>}
          {detail.evidence.omitted > 0 && <p className="text-xs text-amber-500">{detail.evidence.omitted} findings omitted by the bounded broker response.</p>}
        </div>
      </Section>

      <Section title="Authorization">
        <RecordGrid items={[detail.authorization]} empty="No authorization record." />
      </Section>
      <Section title="Amendment history">
        <RecordGrid items={detail.amendments} empty="No authorization amendments." />
      </Section>
      {onAction && <AmendmentControls detail={detail} onAction={onAction} pending={actionPending} />}
      <Section title="Entities & relations">
        <div className="grid gap-4 xl:grid-cols-2">
          <RecordGrid items={detail.entities.items} empty="No entities." />
          <RecordGrid items={detail.relations.items} empty="No relations." />
        </div>
      </Section>
      <Section title="Collection rounds">
        <RecordGrid items={detail.rounds} empty="No rounds." />
      </Section>
      <Section title="Pivot proposals">
        <RecordGrid items={detail.pivots} empty="No pivot proposals." />
      </Section>
      <Section title="Collection plan">
        <p className="mb-3 text-xs text-[var(--theme-muted)]">
          {detail.collection_plan.limits.timeout_seconds}s timeout ·{' '}
          {detail.collection_plan.limits.output_limit_bytes.toLocaleString()} byte output cap · heavy concurrency{' '}
          {detail.collection_plan.limits.heavy_concurrency}
        </p>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {detail.collection_plan.adapters.map((item) => (
            <article
              className="rounded-xl border border-[var(--theme-border)] bg-[var(--theme-bg)] p-3"
              key={item.adapter}
            >
              <div className="flex flex-wrap items-center gap-2">
                <strong className="font-mono text-sm text-[var(--theme-text)]">{item.adapter}</strong>
                <StateBadge value={item.classification} />
              </div>
              <p className="mt-2 text-xs font-medium text-[var(--theme-text)]">{item.reason}</p>
              <p className="mt-1 text-[11px] text-[var(--theme-muted)]">
                {item.input_type} · {item.egress_class} · {item.heavy ? 'heavy' : 'light'}
              </p>
            </article>
          ))}
        </div>
      </Section>
      <Section title="Latest analyst report">
        {detail.report ? (
          <div>
            <div className="mb-3 text-xs text-[var(--theme-muted)]">
              {detail.report.filename} · {detail.report.bytes.toLocaleString()} bytes · SHA-256 {shortHash(detail.report.sha256)}
            </div>
            <div className="prose prose-sm max-w-none text-[var(--theme-text)] dark:prose-invert">
              <Markdown>{detail.report.markdown}</Markdown>
            </div>
          </div>
        ) : (
          <p className="text-sm text-[var(--theme-muted)]">No completed round report is available.</p>
        )}
      </Section>
      {!integrity.manifest_matches && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-500">
          Integrity mismatch: {integrity.modified_count} modified, {integrity.missing_count} missing, {integrity.extra_count} extra files.
        </div>
      )}
    </div>
  )
}

type CaseListResponse = { ok: boolean; cases?: Array<OsintCaseOverview>; error?: string }
type CaseDetailResponse = { ok: boolean; detail?: OsintCaseDetail; error?: string }

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' })
  const body = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(body.error || 'OSINT broker request failed')
  return body
}

export function OsintScreen() {
  usePageTitle('OSINT Cases')
  const [cases, setCases] = useState<Array<OsintCaseOverview>>([])
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null)
  const [detail, setDetail] = useState<OsintCaseDetail | null>(null)
  const [loadingCases, setLoadingCases] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [actionPending, setActionPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoadingCases(true)
    setError(null)
    void fetchJson<CaseListResponse>('/api/osint')
      .then((body) => {
        if (cancelled) return
        const next = body.cases ?? []
        setCases(next)
        setSelectedCaseId((current) =>
          current && next.some((item) => item.case_id === current)
            ? current
            : next[0]?.case_id ?? null,
        )
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Unable to load cases')
      })
      .finally(() => {
        if (!cancelled) setLoadingCases(false)
      })
    return () => {
      cancelled = true
    }
  }, [refresh])

  useEffect(() => {
    if (!selectedCaseId) {
      setDetail(null)
      return
    }
    let cancelled = false
    setLoadingDetail(true)
    setError(null)
    void fetchJson<CaseDetailResponse>(`/api/osint?caseId=${encodeURIComponent(selectedCaseId)}`)
      .then((body) => {
        if (!cancelled) setDetail(body.detail ?? null)
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setDetail(null)
          setError(cause instanceof Error ? cause.message : 'Unable to load case')
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedCaseId, refresh])

  const reload = useCallback(() => setRefresh((value) => value + 1), [])
  const performAction = useCallback(async (action: OsintActionInput) => {
    setActionPending(true)
    setError(null)
    try {
      const result = await fetch('/api/osint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action),
      })
      const body = (await result.json()) as CaseDetailResponse
      if (!result.ok || !body.detail) {
        throw new Error(body.error || 'OSINT action failed')
      }
      setDetail(body.detail)
      setRefresh((value) => value + 1)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'OSINT action failed')
    } finally {
      setActionPending(false)
    }
  }, [])

  return (
    <div className="flex h-full min-h-0 bg-[var(--theme-bg)]">
      <aside className="w-80 shrink-0 overflow-y-auto border-r border-[var(--theme-border)] bg-[var(--theme-bg-elevated)]">
        <div className="sticky top-0 z-10 border-b border-[var(--theme-border)] bg-[var(--theme-bg-elevated)] p-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h1 className="font-semibold text-[var(--theme-text)]">OSINT cases</h1>
              <p className="text-xs text-[var(--theme-muted)]">Sanitized evidence workspace</p>
            </div>
            <Button onClick={reload} size="sm" variant="outline">Refresh</Button>
          </div>
        </div>
        {loadingCases ? (
          <p className="p-4 text-sm text-[var(--theme-muted)]">Loading cases…</p>
        ) : (
          <OsintCaseListView cases={cases} selectedCaseId={selectedCaseId} onSelect={setSelectedCaseId} />
        )}
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-6">
        {error && (
          <div className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-500">{error}</div>
        )}
        {loadingDetail ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--theme-muted)]">Loading case evidence…</div>
        ) : detail ? (
          <OsintCaseDetailView actionPending={actionPending} detail={detail} onAction={performAction} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-[var(--theme-muted)]">
            {cases.length ? 'Select a case.' : 'No case evidence is available.'}
          </div>
        )}
      </main>
    </div>
  )
}
