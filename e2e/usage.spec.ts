import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test as base, expect } from './fixtures'

/**
 * The usage ring, against a stand-in for Anthropic's usage endpoint. The sign-in is a credentials
 * file in the profile's Claude directory, which is where Claude Code keeps it off the keychain —
 * so nothing here reads the real sign-in or reaches the network.
 */
const FIXTURE = {
  limits: [
    { kind: 'session', percent: 42, resets_at: new Date(Date.now() + 90 * 60_000).toISOString() },
    { kind: 'weekly_all', percent: 87, resets_at: new Date(Date.now() + 3 * 86_400_000).toISOString() }
  ],
  spend: { enabled: false }
}

const test = base.extend<{ usageServer: { url: string; auth: string[] } }>({
  usageServer: async ({}, use) => {
    const auth: string[] = []
    const server: Server = createServer((req, res) => {
      auth.push(String(req.headers.authorization ?? ''))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(FIXTURE))
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const { port } = server.address() as AddressInfo
    await use({ url: `http://127.0.0.1:${port}/usage`, auth })
    server.close()
  },
  appEnv: async ({ usageServer }, use) => {
    await use({ MAESTRO_CLAUDE_USAGE_URL: usageServer.url })
  }
})

test('the usage ring shows every plan limit once Claude is signed in', async ({
  window,
  profileDir,
  usageServer
}) => {
  const ring = window.locator('.usage__button')
  await ring.click()
  const pop = window.locator('.usage__pop')
  await expect(pop).toContainText('Not signed in to Claude')
  expect(usageServer.auth).toHaveLength(0)

  const claudeDir = join(profileDir, 'claude')
  await mkdir(claudeDir, { recursive: true })
  await writeFile(
    join(claudeDir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken: 'test-token', expiresAt: Date.now() + 3_600_000, subscriptionType: 'max' }
    })
  )
  await window.click('[aria-label="Refresh usage"]')

  await expect(pop.locator('.usage__row')).toHaveCount(2)
  await expect(pop.locator('.usage__row').nth(0)).toContainText('Session')
  await expect(pop.locator('.usage__row').nth(0)).toContainText('42%')
  await expect(pop.locator('.usage__row').nth(0)).toContainText(/Resets in 1h (29|30)m/)
  await expect(pop.locator('.usage__row').nth(1)).toContainText('Weekly')
  await expect(pop.locator('.usage__row').nth(1)).toContainText('87%')
  await expect(pop.locator('.usage__bar').nth(1)).toHaveClass(/is-high/)
  await expect(pop.locator('.usage__plan')).toHaveText('max')
  expect(usageServer.auth).toContain('Bearer test-token')

  // The ring fills to the limit closest to running out.
  await expect(window.locator('.usage-ring')).toHaveClass(/is-high/)

  await window.keyboard.press('Escape')
  await expect(pop).toHaveCount(0)
})
