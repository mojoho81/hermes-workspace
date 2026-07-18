import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

import { guardVerdict } from './guard-build.mjs'

const created: Array<string> = []
const guard = join(process.cwd(), 'scripts', 'guard-build.mjs')

function runGuard(
  serviceExit: number,
  serviceState = '',
  override = false,
  systemctlPresent = true,
) {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-build-guard-'))
  created.push(dir)
  if (systemctlPresent) {
    const systemctl = join(dir, 'systemctl')
    writeFileSync(
      systemctl,
      `#!/bin/sh\nprintf '%s\\n' '${serviceState}'\nexit ${serviceExit}\n`,
    )
    chmodSync(systemctl, 0o755)
  }
  return spawnSync(process.execPath, [guard], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: dir,
      HERMES_WORKSPACE_ALLOW_ACTIVE_BUILD: override ? '1' : '',
    },
  })
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('production build guard', () => {
  it('refuses an in-place build while hermes-workspace.service is active', () => {
    const result = runGuard(0, 'active')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('scripts/deploy.sh')
  })

  it('allows a normal build when the service is inactive', () => {
    const result = runGuard(3, 'inactive')
    expect(result.status).toBe(0)
  })

  it('fails closed when service state cannot be established', () => {
    const result = runGuard(1, '')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('fails closed')
  })

  it('fails closed when systemctl is missing under a systemd runtime', () => {
    const result = runGuard(0, 'active', false, false)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('fails closed')
  })

  it('requires an explicit escape hatch to override an active-service refusal', () => {
    const result = runGuard(0, 'active', true)
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('unsafe active-service build override')
  })

  it('honors the explicit override even when systemctl is unavailable', () => {
    const result = runGuard(1, '', true, false)
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('unsafe active-service build override')
  })

  it.each(['activating', 'deactivating', 'unknown'])(
    'fails closed when rc 3 reports the non-inactive state %s',
    (serviceState) => {
      const result = runGuard(3, serviceState)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('fails closed')
    },
  )
})

describe('guard verdict logic', () => {
  it('skips the service guard entirely outside a systemd runtime', () => {
    expect(guardVerdict({ override: false, systemd: false }).code).toBe(0)
  })

  it('fails closed under systemd when the probe errors', () => {
    const verdict = guardVerdict({
      override: false,
      systemd: true,
      probe: { error: new Error('ENOENT'), status: null },
    })
    expect(verdict.code).toBe(1)
    expect(verdict.message).toContain('fails closed')
  })

  it('refuses under systemd when the service is active', () => {
    const verdict = guardVerdict({
      override: false,
      systemd: true,
      probe: { status: 0, stdout: 'active\n' },
    })
    expect(verdict.code).toBe(1)
    expect(verdict.message).toContain('scripts/deploy.sh')
  })

  it('allows under systemd when the service is cleanly inactive', () => {
    const verdict = guardVerdict({
      override: false,
      systemd: true,
      probe: { status: 3, stdout: 'inactive\n' },
    })
    expect(verdict.code).toBe(0)
  })
})
