import { defineConfig } from '@playwright/test'

/**
 * Drives the packaged-shape build (out/) rather than the dev server, so what is tested is what
 * ships. Serial and single-worker: each test launches a real Electron app with real PTYs.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' }
})
