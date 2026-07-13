import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { isAuthenticated } from '../../server/auth-middleware'
import { loadWorkspaceCatalog } from './workspace'
import { Route } from './files'

/**
 * Regression tests — /api/files must not 500 when no workspace is selected.
 *
 * getWorkspaceRoot() used to throw 'No valid workspace selected', which the
 * catch-all turned into a generic {"error":"Internal server error"} 500 and
 * the Files screen rendered a dead error. The fix returns a structured
 * {ok:false, code:'no_workspace'} payload (503, mirroring the
 * capability_unavailable convention in mcp.ts) that clients can branch on.
 */

vi.mock('../../server/auth-middleware', () => ({
  isAuthenticated: vi.fn(),
  requireLocalOrAuth: vi.fn(() => true),
}))
vi.mock('./workspace', () => ({
  loadWorkspaceCatalog: vi.fn(),
}))

type Handler = (ctx: { request: Request }) => Promise<Response>
type RouteWithHandlers = typeof Route & {
  options: {
    server: {
      handlers: {
        GET: Handler
        POST: Handler
      }
    }
  }
}

const handlers = (Route as RouteWithHandlers).options.server.handlers

type Catalog = Awaited<ReturnType<typeof loadWorkspaceCatalog>>

function emptyCatalog(): Catalog {
  return {
    path: '',
    folderName: '',
    source: 'none',
    isValid: false,
    workspaces: [],
    last: '',
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(isAuthenticated).mockReturnValue(true)
})

describe('GET /api/files with no valid workspace', () => {
  it('returns a structured no_workspace payload instead of a 500', async () => {
    vi.mocked(loadWorkspaceCatalog).mockResolvedValue(emptyCatalog())
    const req = new Request('http://localhost/api/files?action=list')
    const res = await handlers.GET({ request: req })

    expect(res.status).not.toBe(500)
    expect(res.status).toBe(503)
    const body = (await res.json()) as {
      ok: boolean
      code: string
      message: string
      entries: Array<unknown>
    }
    expect(body.ok).toBe(false)
    expect(body.code).toBe('no_workspace')
    expect(body.message).toMatch(/workspace/i)
    expect(body.entries).toEqual([])
  })
})

describe('POST /api/files with no valid workspace', () => {
  it('returns a structured no_workspace payload instead of a 500', async () => {
    vi.mocked(loadWorkspaceCatalog).mockResolvedValue(emptyCatalog())
    const req = new Request('http://localhost/api/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'write', path: 'a.txt', content: 'x' }),
    })
    const res = await handlers.POST({ request: req })

    expect(res.status).not.toBe(500)
    expect(res.status).toBe(503)
    const body = (await res.json()) as { ok: boolean; code: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe('no_workspace')
  })
})

describe('GET /api/files with a valid workspace (regression)', () => {
  it('still lists directory entries normally', async () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'files-no-workspace-test-'),
    )
    fs.writeFileSync(path.join(tmpRoot, 'hello.txt'), 'hi')
    vi.mocked(loadWorkspaceCatalog).mockResolvedValue({
      ...emptyCatalog(),
      path: tmpRoot,
      folderName: path.basename(tmpRoot),
      source: 'env',
      isValid: true,
      last: tmpRoot,
    })

    const req = new Request('http://localhost/api/files?action=list')
    const res = await handlers.GET({ request: req })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      entries: Array<{ name: string }>
    }
    expect(body.entries.some((e) => e.name === 'hello.txt')).toBe(true)
  })
})
