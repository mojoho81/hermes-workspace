// @vitest-environment jsdom
import React from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type,
  }: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
    type?: 'button' | 'submit' | 'reset'
  }) => React.createElement('button', { onClick, disabled, type }, children),
}))

// eslint-disable-next-line import/first
import { PivotControls } from './osint-screen'
// eslint-disable-next-line import/first
import type { OsintCaseDetail } from './osint-screen'

const findingId = `finding-${'b'.repeat(32)}`
const pendingProposalId = `pivot-${'a'.repeat(64)}`

const detail = {
  case: { case_id: 'case-alpha', state: 'REVIEW' },
  evidence: {
    findings: [
      {
        finding_id: findingId,
        citation_id: 'CIT-0001',
        tool: 'sherlock',
        status: 'HIT',
      },
    ],
  },
  pivots: [
    {
      proposal_id: pendingProposalId,
      review_state: 'PROPOSED',
      execution_state: 'NOT_SCHEDULED',
      selector_type: 'username',
      recommended_adapter: 'sherlock',
      reason: 'Check the bounded account lead.',
      confidence: 0.8,
      parent_finding_ids: [findingId],
    },
    {
      proposal_id: `pivot-${'c'.repeat(64)}`,
      review_state: 'APPROVED',
      execution_state: 'NOT_SCHEDULED',
      selector_type: 'username',
      recommended_adapter: 'sherlock',
      reason: 'Approved bounded lead.',
      confidence: 0.7,
      parent_finding_ids: [findingId],
    },
  ],
  collection_plan: {
    adapters: [
      {
        adapter: 'sherlock',
        input_type: 'username',
        egress_class: 'public-web',
        heavy: true,
        classification: 'WILL_RUN',
        reason: 'AUTHORIZED_AND_CONFIGURED',
      },
    ],
  },
} as unknown as OsintCaseDetail

async function renderControls(
  onAction: (action: unknown) => Promise<void>,
  detailOverride: OsintCaseDetail = detail,
) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await React.act(() => {
    root.render(
      <PivotControls detail={detailOverride} pending={false} onAction={onAction as never} />,
    )
  })
  return { container, root }
}

async function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await React.act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element),
      'value',
    )?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('PivotControls', () => {
  it('submits one bounded metadata-governed proposal without rendering the selector afterward', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined)
    const { container, root } = await renderControls(onAction)
    const selector = container.querySelector<HTMLInputElement>('[aria-label="Pivot selector"]')
    const reason = container.querySelector<HTMLTextAreaElement>('[aria-label="Pivot reason"]')
    expect(selector).not.toBeNull()
    expect(reason).not.toBeNull()
    await setValue(selector!, 'private-account')
    await setValue(reason!, 'Check the bounded account lead from CIT-0001.')

    const button = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent === 'Propose pivot',
    )
    await React.act(() => button?.click())

    expect(onAction).toHaveBeenCalledWith({
      action: 'pivot-propose',
      caseId: 'case-alpha',
      selectorType: 'username',
      selector: 'private-account',
      reason: 'Check the bounded account lead from CIT-0001.',
      confidence: 0.5,
      parentFindingIds: [findingId],
      recommendedAdapter: 'sherlock',
    })
    expect(container.textContent).not.toContain('private-account')
    await React.act(() => root.unmount())
  })

  it('reviews pending metadata and executes all approved unscheduled pivots once', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined)
    const { container, root } = await renderControls(onAction)
    const rationale = container.querySelector<HTMLTextAreaElement>(
      `[aria-label="Pivot review rationale for ${pendingProposalId}"]`,
    )
    expect(rationale).not.toBeNull()
    await setValue(rationale!, 'Parent finding and bounded adapter verified.')

    const approve = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent === 'Approve pivot',
    )
    await React.act(() => approve?.click())
    const question = container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Approved pivot round question"]',
    )
    expect(question).not.toBeNull()
    await setValue(question!, 'Execute every approved pivot exactly once.')
    const execute = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent === 'Run approved pivots',
    )
    await React.act(() => execute?.click())

    expect(onAction).toHaveBeenNthCalledWith(1, {
      action: 'pivot-review',
      caseId: 'case-alpha',
      proposalId: pendingProposalId,
      decision: 'APPROVED',
      rationale: 'Parent finding and bounded adapter verified.',
    })
    expect(onAction).toHaveBeenNthCalledWith(2, {
      action: 'pivot-execute',
      caseId: 'case-alpha',
      question: 'Execute every approved pivot exactly once.',
    })
    await React.act(() => root.unmount())
  })

  it('disables review and execution controls outside the REVIEW state', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined)
    const closedDetail = {
      ...(detail as unknown as Record<string, unknown>),
      case: { case_id: 'case-alpha', state: 'CLOSED' },
    } as unknown as OsintCaseDetail
    const { container, root } = await renderControls(onAction, closedDetail)

    const rationale = container.querySelector<HTMLTextAreaElement>(
      `[aria-label="Pivot review rationale for ${pendingProposalId}"]`,
    )
    expect(rationale).not.toBeNull()
    await setValue(rationale!, 'A closed case must not accept reviews.')

    const buttons = Array.from(container.querySelectorAll('button'))
    const approve = buttons.find((item) => item.textContent === 'Approve pivot')
    const reject = buttons.find((item) => item.textContent === 'Reject pivot')
    const execute = buttons.find((item) => item.textContent === 'Run approved pivots')
    expect(approve?.disabled).toBe(true)
    expect(reject?.disabled).toBe(true)
    expect(execute?.disabled).toBe(true)

    await React.act(() => approve?.click())
    await React.act(() => reject?.click())
    expect(onAction).not.toHaveBeenCalled()
    await React.act(() => root.unmount())
  })
})
