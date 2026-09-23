import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run a production build of the front end (so the service
 * worker and offline behaviour are real) against the mock API
 * (`vite build --mode mock`, served by `vite preview`) in an iPhone-sized Chromium. They can't prove iOS
 * Safari behaviour; the on-device checks in SETUP.md cover that.
 *
 * Locally, set PW_CHROMIUM_PATH to use a pre-installed Chromium instead of
 * `npx playwright install chromium`.
 */
const PORT = 5174;
const BASE = `http://localhost:${PORT}/VehicleTracker/`;
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    ...devices['iPhone 13'],
    browserName: 'chromium',
    baseURL: BASE,
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    trace: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: `npx vite build --mode mock --outDir dist-mock && npx vite preview --outDir dist-mock --port ${PORT} --strictPort`,
    url: BASE,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
