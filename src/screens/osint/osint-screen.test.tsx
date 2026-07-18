import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  OsintCaseDetailView,
  OsintCaseListView,
} from './osint-screen'
import type { OsintCaseDetail, OsintCaseOverview } from './osint-screen'

const cases: Array<OsintCaseOverview> = [
  {
    case_id: 'case-alpha',
    state: 'REVIEW',
    question: 'Which public records answer the case question?',
    created_utc: '2026-07-17T00:00:00+00:00',
    updated_utc: '2026-07-17T01:00:00+00:00',
    finding_count: 4,
    substantive_count: 2,
  },
]

const detail: OsintCaseDetail = {
  case: {
    case_id: 'case-alpha',
    state: 'REVIEW',
    created_utc: '2026-07-17T00:00:00+00:00',
    updated_utc: '2026-07-17T01:00:00+00:00',
    question: 'Which public records answer the case question?',
    authority: 'Authorized fixture investigation',
  },
  authorization: {
    scope: 'Public records only',
    methods: ['sherlock'],
    egress_approvals: ['public-web'],
    max_rounds: 3,
  },
  amendments: [
    {
      amendment_id: 'amendment-1',
      status: 'PENDING',
      changes: { max_rounds: 4 },
      rationale: 'One additional bounded cycle',
      proposed_by: 'workspace-user',
      proposed_utc: '2026-07-17T01:00:00+00:00',
    },
  ],
  evidence: {
    counts_by_role: { SUBSTANTIVE: 2, COVERAGE: 1, PROVENANCE_ONLY: 1 },
    counts_by_status: { HIT: 3, NO_HIT: 1 },
    counts_by_tool: { sherlock: 4 },
    total: 4,
    omitted: 0,
    findings: [
      {
        citation_id: 'CIT-0003',
        finding_id: 'finding-3',
        round_id: 'round-1',
        evidence_role: 'SUBSTANTIVE',
        tool: 'sherlock',
        tool_version: '1.0',
        source_url_or_record_id: 'https://public.example/profile',
        collected_utc: '2026-07-17T00:30:00+00:00',
        method: 'sherlock',
        bytes: 321,
        mime: 'application/json',
        sha256: 'a'.repeat(64),
        status: 'HIT',
        egress_class: 'public-web',
        confidence: 'high',
        confidence_reason: 'Parsed public account',
        parent_finding_ids: [],
        normalized_result: {
          kind: 'account',
          display: 'Public account match',
          site: 'Public Example',
        },
      },
    ],
  },
  entities: {
    total: 1,
    items: [{ entity_id: 'entity-1', type: 'account', label: 'Public account' }],
  },
  relations: {
    total: 1,
    items: [
      {
        relation_id: 'relation-1',
        source_entity_id: 'entity-1',
        target_entity_id: 'entity-2',
        relation_type: 'same_identity',
      },
    ],
  },
  rounds: [{ round_id: 'round-1', state: 'COMPLETE', question: 'First cycle' }],
  pivots: [
    {
      proposal_id: 'pivot-1',
      review_state: 'PROPOSED',
      rationale: 'Verify another public source',
    },
  ],
  collection_plan: {
    limits: {
      timeout_seconds: 30,
      output_limit_bytes: 4194304,
      heavy_concurrency: 1,
    },
    adapters: [
      {
        adapter: 'sherlock',
        input_type: 'username',
        egress_class: 'public-web',
        heavy: true,
        classification: 'WILL_RUN',
        reason: 'AUTHORIZED_AND_CONFIGURED',
      },
      {
        adapter: 'ignorant',
        input_type: 'phone',
        egress_class: 'public-web',
        heavy: true,
        classification: 'NOT_CONFIGURED',
        reason: 'UNSAFE_BINARY',
      },
    ],
  },
  report: {
    round_id: 'round-1',
    sha256: 'b'.repeat(64),
    bytes: 512,
    filename: 'round-1.md',
    markdown: '## Analyst conclusion\n\nThe cited public evidence supports the finding.',
  },
  integrity: {
    manifest_matches: true,
    modified_count: 0,
    missing_count: 0,
    extra_count: 0,
  },
}

describe('OSINT case browser views', () => {
  it('renders case identity, state, question, and evidence totals in the list', () => {
    const html = renderToStaticMarkup(
      <OsintCaseListView cases={cases} selectedCaseId="case-alpha" onSelect={() => {}} />,
    )

    expect(html).toContain('case-alpha')
    expect(html).toContain('REVIEW')
    expect(html).toContain('Which public records answer the case question?')
    expect(html).toContain('2 substantive')
    expect(html).toContain('4 findings')
  })

  it('renders substantive evidence, governance, graph, rounds, pivots, integrity, and report', () => {
    const html = renderToStaticMarkup(
      <OsintCaseDetailView detail={detail} onAction={() => Promise.resolve()} />,
    )

    for (const value of [
      'CIT-0003',
      'Public account match',
      'Parsed public account',
      'aaaaaaaaaaaa',
      'Authorization',
      'Public records only',
      'Amendment history',
      'One additional bounded cycle',
      'Propose authorization amendment',
      'Approve amendment',
      'Reject amendment',
      'Entities &amp; relations',
      'Public account',
      'Collection rounds',
      'First cycle',
      'Pivot proposals',
      'Verify another public source',
      'Collection plan',
      'Run authorized collection',
      'sherlock',
      'Username selector',
      'Run collection',
      'WILL_RUN',
      'NOT_CONFIGURED',
      'UNSAFE_BINARY',
      '30s timeout',
      'Manifest verified',
      'Analyst conclusion',
      'The cited public evidence supports the finding.',
    ]) {
      expect(html).toContain(value)
    }
  })
})
