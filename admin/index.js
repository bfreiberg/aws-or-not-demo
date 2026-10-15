import { serve } from '@hono/node-server';
import { readFile } from 'node:fs/promises';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { createDocClient } from '../shared/db/client.js';
import { createStore } from '../shared/db/store.js';
import { lazy } from '../shared/http.js';
import { createAdminApp } from './app.js';

const questions = Object.freeze(JSON.parse(await readFile(new URL('./assets/questions.json', import.meta.url), 'utf8')));
const store = createStore({ doc: createDocClient(), tableName: process.env.TABLE_NAME ?? 'aws-or-not' });

// The client ID is read lazily from SSM: it's created after this function's endpoint (its callback URL needs
// the endpoint domain), so it may not exist yet when an environment initialises.
const ssm = new SSMClient({});
const getClientId = process.env.CLIENT_ID
  ? async () => process.env.CLIENT_ID
  : lazy(async () => (await ssm.send(new GetParameterCommand({ Name: process.env.CLIENT_ID_PARAM }))).Parameter.Value);

const getVerifier = lazy(async () => CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID,
  tokenUse: 'id',
  clientId: await getClientId(),
  groups: 'admins',
}));

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

const app = createAdminApp({
  store,
  questions,
  verifier: { verify: async (token) => (await getVerifier()).verify(token) },
  cognito: { domain: process.env.COGNITO_DOMAIN, getClientId },
  now: Date.now,
  publicOrigin: process.env.PUBLIC_ORIGIN,
  getOriginSecret: makeGetOriginSecret(process.env.ORIGIN_SECRET_ID),
});

const [HOST, PORT] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || '0.0.0.0:3001').split(':');
serve({ fetch: app.fetch, port: Number(PORT), hostname: HOST }, () => {
  console.log(JSON.stringify({ level: 'info', message: 'admin listening', host: HOST, port: PORT }));
});
