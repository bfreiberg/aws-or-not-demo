import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    globalSetup: ['test/global-setup.js'],
    env: {
      DYNAMODB_ENDPOINT: 'http://localhost:8000',
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'local',
      AWS_SECRET_ACCESS_KEY: 'local',
    },
    testTimeout: 15_000,
  },
});
