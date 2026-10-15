import { serve } from '@hono/node-server';
import { readFile } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createDocClient } from '../shared/db/client.js';
import { createStore } from '../shared/db/store.js';
import { createConfigCache } from '../shared/config-cache.js';
import { makeHashIp } from '../shared/http.js';
import { generateHandle } from '../shared/handle.js';
import { initCard } from '../shared/card.js';
import { createGameApp } from './app.js';

const assetDir = new URL('./assets/', import.meta.url);
const questions = Object.freeze(JSON.parse(await readFile(new URL('questions.json', assetDir), 'utf8')));
const store = createStore({ doc: createDocClient(), tableName: process.env.TABLE_NAME ?? 'aws-or-not' });

async function loadSalt() {
  const secretId = process.env.IP_SALT_SECRET_ARN;
  if (!secretId) return 'local-dev-salt';
  const { SecretString } = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretId }));
  return SecretString;
}

// Returns a getSecret function that caches the origin-verify secret for up to 5 minutes.
// A failed load is not cached, so the next request retries. When the env var is absent,
// returns undefined so the middleware skips origin verification (local dev / tests).
function makeGetOriginSecret(secretId) {
  if (!secretId) return undefined;
  const client = new SecretsManagerClient({ region: 'us-east-1' });
  const TTL = 5 * 60 * 1000;
  let cached;
  let cachedAt = 0;
  return async () => {
    const now = Date.now();
    if (cached !== undefined && now - cachedAt < TTL) return cached;
    const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    cached = SecretString;
    cachedAt = now;
    return cached;
  };
}

const [salt] = await Promise.all([loadSalt(), initCard(assetDir)]);

const app = createGameApp({
  store,
  questions,
  config: createConfigCache(() => store.getConfig()),
  now: Date.now,
  rng: Math.random,
  newRunId: () => nanoid(),
  newResultId: () => nanoid(8),
  hashIp: makeHashIp(salt),
  generateHandle,
  assetDir,
  publicOrigin: process.env.PUBLIC_ORIGIN,
  getOriginSecret: makeGetOriginSecret(process.env.ORIGIN_SECRET_ID),
});

const [HOST, PORT] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || '0.0.0.0:3000').split(':');
serve({ fetch: app.fetch, port: Number(PORT), hostname: HOST }, () => {
  console.log(JSON.stringify({ level: 'info', message: 'game listening', host: HOST, port: PORT, questions: questions.length }));
});
