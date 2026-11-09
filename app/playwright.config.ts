// The dashboard's end-to-end tests (`pnpm test:ui`): Playwright drives the Vite dev server, pointed at a daemon on a
// scratch home with a task in every stage (e2e/harness/daemon.mjs). Both are started here and stopped afterwards.
//
// The `look` specs only read: the screenshots and the contrast check, then what each page shows. The `act` specs change
// the seeded tasks (a merge, an approval), so they run after every `look` spec, one at a time.
import { defineConfig } from '@playwright/test';
import { APP_PORT, APP_URL as APP, DAEMON_PORT, DAEMON_URL as DAEMON } from './e2e/ports';

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e/results',
  // One worker: the specs share one daemon, and the screenshots need a quiet machine.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  timeout: 30_000,
  reporter: process.env.CI ? [['list'], ['html', { outputFolder: 'e2e/report', open: 'never' }]] : 'list',
  // One stored image per screenshot and platform: fonts render differently on macOS and Linux. A platform's first run
  // writes its images and passes (`missing`); commit them, and every later run compares with them. CI uploads the ones
  // it wrote (the `ui-screenshots` artifact), to commit for Linux.
  snapshotPathTemplate: '{testDir}/screenshots/{arg}-{platform}{ext}',
  updateSnapshots: 'missing',
  expect: { timeout: 10_000, toHaveScreenshot: { maxDiffPixelRatio: 0.005, animations: 'disabled', caret: 'hide' } },
  use: {
    baseURL: APP,
    browserName: 'chromium',
    viewport: { width: 1280, height: 800 },
    locale: 'en-GB',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'look', testMatch: /look\/.*\.spec\.ts$/ },
    { name: 'act', testMatch: /act\/.*\.spec\.ts$/, dependencies: ['look'] },
  ],
  webServer: [
    {
      command: `node e2e/harness/daemon.mjs --port ${DAEMON_PORT} --origin ${APP}`,
      url: `${DAEMON}/api/status`,
      timeout: 120_000,
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
      stdout: process.env.UI_DAEMON_VERBOSE ? 'pipe' : 'ignore',
    },
    {
      command: `vite --port ${APP_PORT} --host 127.0.0.1 --strictPort`,
      url: APP,
      timeout: 60_000,
      reuseExistingServer: false,
      env: { VITE_AGENTDECK_API: DAEMON },
    },
  ],
});
