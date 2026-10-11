import { defineConfig } from '@playwright/test'

/**
 * Drives the packaged-shape build (out/) rather than the dev server, so what is tested is what
 * ships. Each test launches its own Electron app on its own throwaway profile, so tests run side by
 * side. Four is the measured sweet spot: six is no faster, and eight starts missing timeouts.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: Number(process.env.MAESTRO_E2E_WORKERS) || 4,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' }
})
