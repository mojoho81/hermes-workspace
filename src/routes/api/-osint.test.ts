import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authenticated: true,
  execFile: vi.fn(),
  stdinEnd: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path: string) => (opts: unknown) => opts,
}))

vi.mock('../../server/auth-middleware', () => ({
  isAuthenticated: () => mocks.authenticated,
}))

vi.mock('node:child_process', () => ({
  execFile: mocks.execFile,
}))

function succeed(payload: object) {
  mocks.execFile.mockImplementation(
    (
      _command: string,
      _args: Array<string>,
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(null, `${JSON.stringify(payload)}\n`, '')
      return {
        stdin: { end: mocks.stdinEnd, on: vi.fn() },
        kill: vi.fn(),
      }
    },
  )
}

function postRequest(body: object, origin = 'https://workspace.example') {
  return new Request('https://workspace.example/api/osint', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      'sec-fetch-site': origin === 'https://workspace.example' ? 'same-origin' : 'cross-site',
    },
    body: JSON.stringify(body),
  })
}

async function handlers() {
  const module = await import('./osint')
  return (module as any).Route.server.handlers
}

beforeEach(() => {
  mocks.authenticated = true
  mocks.execFile.mockReset()
  mocks.stdinEnd.mockReset()
  vi.resetModules()
})

describe('/api/osint broker', () => {
  it('requires authenticated Workspace access', async () => {
    mocks.authenticated = false
    succeed({ ok: true, cases: [] })
    const route = await handlers()

    const response = await route.GET({
      request: new Request('https://workspace.example/api/osint'),
    })

    expect(response.status).toBe(401)
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it('lists cases through fixed Python module arguments and bounded output', async () => {
    succeed({ ok: true, cases: [{ case_id: 'case-one' }] })
    const route = await handlers()

    const response = await route.GET({
      request: new Request('https://workspace.example/api/osint'),
    })
    const body = await response.json()

    expect(body).toEqual({ ok: true, cases: [{ case_id: 'case-one' }] })
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
    const [command, args, options] = mocks.execFile.mock.calls[0]
    expect(command).toBe('/usr/local/lib/hermes-agent/venv/bin/python')
    expect(args).toEqual(['-m', 'osint_platform.workspace_api', 'list'])
    expect(options).toMatchObject({
      cwd: '/root/osint-platform',
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
      shell: false,
    })
    expect(options.env.PYTHONPATH).toBe('/root/osint-platform/src')
    expect(options.env.OSINT_CASE_ROOT).toBe('/root/osint/cases')
  })

  it('loads a strict case id without constructing a shell command', async () => {
    succeed({ ok: true, detail: { case: { case_id: 'case-one' } } })
    const route = await handlers()

    const response = await route.GET({
      request: new Request(
        'https://workspace.example/api/osint?caseId=case-one',
      ),
    })

    expect(response.status).toBe(200)
    expect(mocks.execFile.mock.calls[0][1]).toEqual([
      '-m',
      'osint_platform.workspace_api',
      'detail',
      '--case-id',
      'case-one',
    ])
  })

  it('rejects path traversal before process launch', async () => {
    succeed({ ok: true })
    const route = await handlers()

    const response = await route.GET({
      request: new Request(
        'https://workspace.example/api/osint?caseId=../private',
      ),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      ok: false,
      error: 'Invalid case request',
    })
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it('rejects cross-origin or out-of-schema mutation requests before process launch', async () => {
    succeed({ ok: true })
    const route = await handlers()

    const crossOrigin = await route.POST({
      request: postRequest(
        {
          action: 'amendment-propose',
          caseId: 'case-one',
          changes: { max_rounds: 4 },
          rationale: 'Bounded extension',
        },
        'https://attacker.example',
      ),
    })
    const forbiddenField = await route.POST({
      request: postRequest({
        action: 'amendment-propose',
        caseId: 'case-one',
        changes: { case_path: '/private' },
        rationale: 'Invalid mutation',
      }),
    })

    expect(crossOrigin.status).toBe(403)
    expect(forbiddenField.status).toBe(400)
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it('proposes an amendment through fixed bounded module arguments', async () => {
    succeed({ ok: true, detail: { case: { case_id: 'case-one' } } })
    const route = await handlers()

    const response = await route.POST({
      request: postRequest({
        action: 'amendment-propose',
        caseId: 'case-one',
        changes: { max_rounds: 4, methods: ['sherlock'] },
        rationale: 'One additional bounded cycle',
      }),
    })

    expect(response.status).toBe(200)
    expect(mocks.execFile.mock.calls[0][1]).toEqual([
      '-m',
      'osint_platform.workspace_api',
      'amendment-propose',
      '--case-id',
      'case-one',
      '--changes-json',
      '{"max_rounds":4,"methods":["sherlock"]}',
      '--rationale',
      'One additional bounded cycle',
    ])
  })

  it('reviews an amendment through a closed decision schema', async () => {
    succeed({ ok: true, detail: { case: { case_id: 'case-one' } } })
    const route = await handlers()

    const response = await route.POST({
      request: postRequest({
        action: 'amendment-review',
        caseId: 'case-one',
        amendmentId: 'amendment-0123456789abcdef0123456789abcdef',
        decision: 'APPROVED',
        rationale: 'Authority and bounds verified',
      }),
    })

    expect(response.status).toBe(200)
    expect(mocks.execFile.mock.calls[0][1]).toEqual([
      '-m',
      'osint_platform.workspace_api',
      'amendment-review',
      '--case-id',
      'case-one',
      '--amendment-id',
      'amendment-0123456789abcdef0123456789abcdef',
      '--decision',
      'APPROVED',
      '--rationale',
      'Authority and bounds verified',
    ])
  })

  it('sends sensitive collection fields only over bounded child stdin', async () => {
    succeed({
      ok: true,
      run: { adapter: 'sherlock', status: 'HIT', finding_count: 1 },
      detail: { case: { case_id: 'case-one', state: 'REVIEW' } },
    })
    const route = await handlers()
    const selector = 'private-fixture@example.test'
    const question = 'Check the authorized private fixture.'

    const response = await route.POST({
      request: postRequest({
        action: 'collection-run',
        caseId: 'case-one',
        adapter: 'user-scanner',
        selectorType: 'email',
        selector,
        question,
      }),
    })

    expect(response.status).toBe(200)
    const [command, args, options] = mocks.execFile.mock.calls[0]
    expect(command).toBe('/usr/local/lib/hermes-agent/venv/bin/python')
    expect(args).toEqual([
      '-m',
      'osint_platform.workspace_api',
      'collection-run-stdin',
    ])
    expect(JSON.stringify(args)).not.toContain(selector)
    expect(JSON.stringify(args)).not.toContain(question)
    expect(mocks.stdinEnd).toHaveBeenCalledOnce()
    expect(JSON.parse(mocks.stdinEnd.mock.calls[0][0])).toEqual({
      case_id: 'case-one',
      adapter: 'user-scanner',
      selector_type: 'email',
      selector,
      question,
    })
    expect(options).toMatchObject({ timeout: 90_000, shell: false })
  })

  it('rejects mismatched or extended collection requests before process launch', async () => {
    succeed({ ok: true })
    const route = await handlers()

    const mismatch = await route.POST({
      request: postRequest({
        action: 'collection-run',
        caseId: 'case-one',
        adapter: 'sherlock',
        selectorType: 'domain',
        selector: 'example.test',
        question: 'Invalid adapter and selector pair.',
      }),
    })
    const extended = await route.POST({
      request: postRequest({
        action: 'collection-run',
        caseId: 'case-one',
        adapter: 'dig',
        selectorType: 'domain',
        selector: 'example.test',
        question: 'Attempt an extended request.',
        executable: '/bin/sh',
      }),
    })

    expect(mismatch.status).toBe(400)
    expect(extended.status).toBe(400)
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it('sends pivot proposal fields only over bounded child stdin', async () => {
    succeed({ ok: true, operation: { proposal_id: `pivot-${'a'.repeat(64)}` } })
    const route = await handlers()
    const selector = 'private-person@example.test'
    const reason = 'Check the bounded private lead from the cited finding.'
    const parentFindingId = `finding-${'b'.repeat(32)}`

    const response = await route.POST({
      request: postRequest({
        action: 'pivot-propose',
        caseId: 'case-one',
        selectorType: 'email',
        selector,
        reason,
        confidence: 0.8,
        parentFindingIds: [parentFindingId],
        recommendedAdapter: 'user-scanner',
      }),
    })

    expect(response.status).toBe(200)
    const [, args, options] = mocks.execFile.mock.calls[0]
    expect(args).toEqual([
      '-m',
      'osint_platform.workspace_pivot_cli',
      'pivot-propose-stdin',
    ])
    expect(JSON.stringify(args)).not.toContain(selector)
    expect(JSON.stringify(args)).not.toContain(reason)
    expect(JSON.parse(mocks.stdinEnd.mock.calls[0][0])).toEqual({
      case_id: 'case-one',
      selector_type: 'email',
      selector,
      reason,
      confidence: 0.8,
      parent_finding_ids: [parentFindingId],
      recommended_adapter: 'user-scanner',
    })
    expect(options).toMatchObject({ timeout: 15_000, shell: false })
  })

  it('reviews and executes pivots through fixed non-sensitive argv', async () => {
    succeed({ ok: true, detail: { case: { case_id: 'case-one' } } })
    const route = await handlers()
    const proposalId = `pivot-${'a'.repeat(64)}`

    const review = await route.POST({
      request: postRequest({
        action: 'pivot-review',
        caseId: 'case-one',
        proposalId,
        decision: 'APPROVED',
        rationale: 'Parent evidence and bounded adapter verified.',
      }),
    })
    const execute = await route.POST({
      request: postRequest({
        action: 'pivot-execute',
        caseId: 'case-one',
        question: 'Execute every approved pivot exactly once.',
      }),
    })

    expect(review.status).toBe(200)
    expect(execute.status).toBe(200)
    expect(mocks.execFile.mock.calls[0][1]).toEqual([
      '-m',
      'osint_platform.workspace_pivot_cli',
      'pivot-review-stdin',
    ])
    expect(mocks.execFile.mock.calls[1][1]).toEqual([
      '-m',
      'osint_platform.workspace_pivot_cli',
      'pivot-execute-stdin',
    ])
    expect(JSON.parse(mocks.stdinEnd.mock.calls[0][0])).toMatchObject({
      proposal_id: proposalId,
      decision: 'APPROVED',
    })
    expect(JSON.parse(mocks.stdinEnd.mock.calls[1][0])).toEqual({
      case_id: 'case-one',
      question: 'Execute every approved pivot exactly once.',
    })
  })

  it('rejects mismatched or extended pivot requests before process launch', async () => {
    succeed({ ok: true })
    const route = await handlers()

    const mismatch = await route.POST({
      request: postRequest({
        action: 'pivot-propose',
        caseId: 'case-one',
        selectorType: 'domain',
        selector: 'example.test',
        reason: 'Invalid pairing.',
        confidence: 0.8,
        parentFindingIds: [`finding-${'b'.repeat(32)}`],
        recommendedAdapter: 'sherlock',
      }),
    })
    const extended = await route.POST({
      request: postRequest({
        action: 'pivot-execute',
        caseId: 'case-one',
        question: 'Attempt extended execution.',
        executable: '/bin/sh',
      }),
    })

    expect(mismatch.status).toBe(400)
    expect(extended.status).toBe(400)
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it('never reflects sensitive collection fields from child failures', async () => {
    const selector = 'private-person@example.test'
    const question = 'Investigate the private person selector.'
    mocks.execFile.mockImplementation(
      (
        _command: string,
        _args: Array<string>,
        _options: object,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(new Error(selector), question, selector)
        return {
          stdin: { end: mocks.stdinEnd, on: vi.fn() },
          kill: vi.fn(),
        }
      },
    )
    const route = await handlers()

    const response = await route.POST({
      request: postRequest({
        action: 'collection-run',
        caseId: 'case-one',
        adapter: 'user-scanner',
        selectorType: 'email',
        selector,
        question,
      }),
    })
    const encoded = JSON.stringify(await response.json())
    const args = JSON.stringify(mocks.execFile.mock.calls[0][1])

    expect(response.status).toBe(502)
    expect(encoded).not.toContain(selector)
    expect(encoded).not.toContain(question)
    expect(args).not.toContain(selector)
    expect(args).not.toContain(question)
  })

  it('returns a generic upstream error for process or JSON failures', async () => {
    mocks.execFile.mockImplementation(
      (
        _command: string,
        _args: Array<string>,
        _options: object,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, 'not-json', 'PRIVATE-CHILD-ERROR'),
    )
    const route = await handlers()

    const response = await route.GET({
      request: new Request('https://workspace.example/api/osint'),
    })
    const encoded = JSON.stringify(await response.json())

    expect(response.status).toBe(502)
    expect(encoded).not.toContain('PRIVATE-CHILD-ERROR')
    expect(encoded).toContain('OSINT broker returned an invalid response')
  })
})
