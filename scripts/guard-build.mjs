#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const SYSTEMD_RUNTIME_DIR = '/run/systemd/system'

export function guardVerdict({ override, systemd, probe }) {
  if (override) {
    return {
      code: 0,
      message:
        'WARN unsafe active-service build override enabled; the running server may lose hashed modules',
    }
  }
  if (!systemd) return { code: 0 }
  const state = probe.stdout?.trim()
  const inactive = probe.status === 3 && state === 'inactive'
  if (probe.error || probe.signal || (probe.status !== 0 && !inactive)) {
    return {
      code: 1,
      message:
        'REFUSED: could not establish hermes-workspace.service state; build guard fails closed',
    }
  }
  if (inactive) return { code: 0 }
  return {
    code: 1,
    message:
      'REFUSED: hermes-workspace.service is active. An in-place Vite build can delete hashed modules used by the running server. Use scripts/deploy.sh for a staged build, atomic activation, restart, and health check. For an intentional emergency override only, set HERMES_WORKSPACE_ALLOW_ACTIVE_BUILD=1.',
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const override = process.env.HERMES_WORKSPACE_ALLOW_ACTIVE_BUILD === '1'
  const systemd = process.platform === 'linux' && existsSync(SYSTEMD_RUNTIME_DIR)
  const probe =
    !override && systemd
      ? spawnSync('systemctl', ['is-active', 'hermes-workspace.service'], {
          encoding: 'utf8',
        })
      : undefined
  const verdict = guardVerdict({ override, systemd, probe })
  if (verdict.message) console.error(verdict.message)
  process.exit(verdict.code)
}
