import { defineConfig, devices } from '@playwright/test';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = 5100;
const BASE_URL = `http://localhost:${PORT}`;
// Isolate E2E workflow files in a temporary directory under the repo so the
// real workflows under .agents/railways are never touched by tests.
const E2E_WORKFLOWS_DIR = resolve(__dirname, '.e2e-workflows');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    headless: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // `RALPH_WEB_TEST_SEED=1` enables the test-only seed endpoint at
    // `/api/_test/runs`, which lets E2E tests populate the in-memory run
    // store without shipping a write API to production. The flag is
    // checked inside the handler too, so a misconfigured production
    // build (env unset) returns 404 from that path.
    command: `RALPH_WORKFLOWS_DIR='${E2E_WORKFLOWS_DIR}' RALPH_WEB_TEST_SEED=1 bun run vite dev --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
