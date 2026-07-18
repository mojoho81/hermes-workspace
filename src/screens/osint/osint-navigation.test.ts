import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('OSINT Workspace navigation', () => {
  it('registers a client route backed by the OSINT screen', () => {
    const route = readFileSync(resolve('src/routes/osint.tsx'), 'utf8')
    expect(route).toContain("createFileRoute('/osint')")
    expect(route).toContain('component: OsintScreen')
  })

  it('exposes OSINT in the desktop sidebar and mobile page title', () => {
    const sidebar = readFileSync(
      resolve('src/screens/chat/components/chat-sidebar.tsx'),
      'utf8',
    )
    const shell = readFileSync(resolve('src/components/workspace-shell.tsx'), 'utf8')

    expect(sidebar).toContain("const isOsintActive = pathname === '/osint'")
    expect(sidebar).toContain("to: '/osint'")
    expect(sidebar).toContain("label: 'OSINT'")
    expect(shell).toContain("pathname.startsWith('/osint')")
    expect(shell).toContain("return 'OSINT Cases'")
  })
})
