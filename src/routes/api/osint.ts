import { execFile } from 'node:child_process'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { z } from 'zod'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'


const CASE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const PYTHON =
  process.env.OSINT_PLATFORM_PYTHON ||
  '/usr/local/lib/hermes-agent/venv/bin/python'
const PLATFORM_ROOT = process.env.OSINT_PLATFORM_ROOT || '/root/osint-platform'
const CASE_ROOT = process.env.OSINT_CASE_ROOT || '/root/osint/cases'
const PYTHONPATH = `${PLATFORM_ROOT}/src`
const MAX_BROKER_BYTES = 8 * 1024 * 1024
const MAX_ACTION_BYTES = 32 * 1024
const boundedText = z.string().trim().min(1).max(4096)
const boundedList = z
  .array(z.string().trim().min(1).max(512))
  .min(1)
  .max(100)
  .refine((items) => new Set(items).size === items.length)
const ChangesSchema = z
  .object({
    scope: boundedText.optional(),
    out_of_scope: boundedText.optional(),
    time_constraints: boundedText.optional(),
    geographic_constraints: boundedText.optional(),
    methods: boundedList.optional(),
    egress_approvals: boundedList.optional(),
    success_criteria: boundedText.optional(),
    stop_criteria: boundedText.optional(),
    retention: boundedText.optional(),
    max_rounds: z.number().int().min(1).max(100).optional(),
  })
  .strict()
  .refine((changes) => Object.keys(changes).length > 0)
const CollectionSchema = z
  .object({
    action: z.literal('collection-run'),
    caseId: z.string().regex(CASE_ID_RE),
    adapter: z.enum([
      'sherlock',
      'user-scanner',
      'ignorant',
      'whois',
      'dig',
      'waybackurls',
      'exiftool',
      'yt-dlp',
      'tesseract',
    ]),
    selectorType: z.enum(['username', 'email', 'phone', 'domain', 'media_path', 'url']),
    selector: z.string().trim().min(1).max(4096),
    question: boundedText,
  })
  .strict()
  .refine(
    (request) =>
      ({
        sherlock: 'username',
        'user-scanner': 'email',
        ignorant: 'phone',
        whois: 'domain',
        dig: 'domain',
        waybackurls: 'domain',
        exiftool: 'media_path',
        'yt-dlp': 'url',
        tesseract: 'media_path',
      })[request.adapter] === request.selectorType,
  )
const PivotProposalSchema = z
  .object({
    action: z.literal('pivot-propose'),
    caseId: z.string().regex(CASE_ID_RE),
    selectorType: z.enum(['username', 'email', 'phone', 'domain', 'media_path', 'url']),
    selector: z.string().trim().min(1).max(4096),
    reason: boundedText,
    confidence: z.number().min(0).max(1),
    parentFindingIds: z
      .array(z.string().regex(/^finding-[0-9a-f]{32}$/))
      .min(1)
      .max(100),
    recommendedAdapter: z.enum([
      'sherlock',
      'user-scanner',
      'ignorant',
      'whois',
      'dig',
      'waybackurls',
      'exiftool',
      'yt-dlp',
      'tesseract',
    ]),
  })
  .strict()
  .refine(
    (request) =>
      ({
        sherlock: 'username',
        'user-scanner': 'email',
        ignorant: 'phone',
        whois: 'domain',
        dig: 'domain',
        waybackurls: 'domain',
        exiftool: 'media_path',
        'yt-dlp': 'url',
        tesseract: 'media_path',
      })[request.recommendedAdapter] === request.selectorType,
  )
const PivotReviewSchema = z
  .object({
    action: z.literal('pivot-review'),
    caseId: z.string().regex(CASE_ID_RE),
    proposalId: z.string().regex(/^pivot-[0-9a-f]{64}$/),
    decision: z.enum(['APPROVED', 'REJECTED']),
    rationale: boundedText,
  })
  .strict()
const PivotExecuteSchema = z
  .object({
    action: z.literal('pivot-execute'),
    caseId: z.string().regex(CASE_ID_RE),
    question: boundedText,
  })
  .strict()
const ActionSchema = z.union([
  z
    .object({
      action: z.literal('amendment-propose'),
      caseId: z.string().regex(CASE_ID_RE),
      changes: ChangesSchema,
      rationale: boundedText,
    })
    .strict(),
  z
    .object({
      action: z.literal('amendment-review'),
      caseId: z.string().regex(CASE_ID_RE),
      amendmentId: z.string().regex(/^amendment-[0-9a-f]{32}$/),
      decision: z.enum(['APPROVED', 'REJECTED']),
      rationale: boundedText,
    })
    .strict(),
  CollectionSchema,
  PivotProposalSchema,
  PivotReviewSchema,
  PivotExecuteSchema,
])

function response(payload: object, status = 200) {
  return json(payload, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

async function runBroker(
  args: Array<string>,
  timeout = 15_000,
  stdinPayload?: string,
  module = 'osint_platform.workspace_api',
): Promise<Record<string, unknown>> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      PYTHON,
      ['-m', module, ...args],
      {
        cwd: PLATFORM_ROOT,
        timeout,
        maxBuffer: MAX_BROKER_BYTES,
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONPATH,
          PYTHONDONTWRITEBYTECODE: '1',
          OSINT_CASE_ROOT: CASE_ROOT,
        },
      },
      (error, value) => {
        if (error) reject(error)
        else resolve(value)
      },
    )
    if (stdinPayload !== undefined) {
      if (child.stdin === null) {
        child.kill()
        reject(new Error('broker stdin unavailable'))
        return
      }
      child.stdin.on('error', reject)
      child.stdin.end(stdinPayload)
    }
  })
  const parsed: unknown = JSON.parse(stdout)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).ok !== true
  ) {
    throw new Error('invalid broker response')
  }
  return parsed as Record<string, unknown>
}

function sameOrigin(request: Request) {
  const expected = new URL(request.url).origin
  const origin = request.headers.get('origin')
  const fetchSite = request.headers.get('sec-fetch-site')
  return origin === expected && (fetchSite === null || fetchSite === 'same-origin')
}

function canonicalChanges(changes: Record<string, unknown>) {
  return JSON.stringify(
    Object.fromEntries(Object.entries(changes).sort(([left], [right]) => left.localeCompare(right))),
  )
}

export const Route = createFileRoute('/api/osint')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return response({ ok: false, error: 'Unauthorized' }, 401)
        }
        const url = new URL(request.url)
        const caseId = url.searchParams.get('caseId')
        if (caseId !== null && !CASE_ID_RE.test(caseId)) {
          return response({ ok: false, error: 'Invalid case request' }, 400)
        }
        try {
          const result = await runBroker(
            caseId === null ? ['list'] : ['detail', '--case-id', caseId],
          )
          return response(result)
        } catch {
          return response(
            {
              ok: false,
              error: 'OSINT broker returned an invalid response',
            },
            502,
          )
        }
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return response({ ok: false, error: 'Unauthorized' }, 401)
        }
        const contentTypeError = requireJsonContentType(request)
        if (contentTypeError) return contentTypeError
        if (!sameOrigin(request)) {
          return response({ ok: false, error: 'Cross-origin request denied' }, 403)
        }
        const raw = await request.text()
        if (new TextEncoder().encode(raw).byteLength > MAX_ACTION_BYTES) {
          return response({ ok: false, error: 'Invalid OSINT action' }, 400)
        }
        let input: unknown
        try {
          input = JSON.parse(raw)
        } catch {
          return response({ ok: false, error: 'Invalid OSINT action' }, 400)
        }
        const parsed = ActionSchema.safeParse(input)
        if (!parsed.success) {
          return response({ ok: false, error: 'Invalid OSINT action' }, 400)
        }
        const action = parsed.data
        let args: Array<string>
        let timeout = 15_000
        let stdinPayload: string | undefined
        let module = 'osint_platform.workspace_api'
        if (action.action === 'amendment-propose') {
          args = [
            'amendment-propose',
            '--case-id',
            action.caseId,
            '--changes-json',
            canonicalChanges(action.changes),
            '--rationale',
            action.rationale,
          ]
        } else if (action.action === 'amendment-review') {
          args = [
            'amendment-review',
            '--case-id',
            action.caseId,
            '--amendment-id',
            action.amendmentId,
            '--decision',
            action.decision,
            '--rationale',
            action.rationale,
          ]
        } else if (action.action === 'collection-run') {
          args = ['collection-run-stdin']
          stdinPayload = JSON.stringify({
            case_id: action.caseId,
            adapter: action.adapter,
            selector_type: action.selectorType,
            selector: action.selector,
            question: action.question,
          })
          timeout = 90_000
        } else {
          module = 'osint_platform.workspace_pivot_cli'
          if (action.action === 'pivot-propose') {
            args = ['pivot-propose-stdin']
            stdinPayload = JSON.stringify({
              case_id: action.caseId,
              selector_type: action.selectorType,
              selector: action.selector,
              reason: action.reason,
              confidence: action.confidence,
              parent_finding_ids: action.parentFindingIds,
              recommended_adapter: action.recommendedAdapter,
            })
          } else if (action.action === 'pivot-review') {
            args = ['pivot-review-stdin']
            stdinPayload = JSON.stringify({
              case_id: action.caseId,
              proposal_id: action.proposalId,
              decision: action.decision,
              rationale: action.rationale,
            })
          } else {
            args = ['pivot-execute-stdin']
            stdinPayload = JSON.stringify({
              case_id: action.caseId,
              question: action.question,
            })
            timeout = 90_000
          }
        }
        try {
          return response(await runBroker(args, timeout, stdinPayload, module))
        } catch {
          return response(
            { ok: false, error: 'OSINT broker returned an invalid response' },
            502,
          )
        }
      },
    },
  },
})
