import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authenticated: true,
  execFile: vi.fn(),
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
    ) => callback(null, `${JSON.stringify(payload)}\n`, ''),
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
