import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 60_000,
  workers: 1,
  use: { baseURL: 'http://localhost:3000' },
  webServer: {
    command: 'node scripts/dev-game.js',
    url: 'http://localhost:3000/api/health',
    reuseExistingServer: false,
    env: { E2E_TIMER_SECONDS: '3' },
  },
});
