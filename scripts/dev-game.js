// Runs the game against DynamoDB Local: `docker compose up -d dynamodb && npm run dev:game`
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { copyAssets } from './assets.js';

process.env.DYNAMODB_ENDPOINT ??= 'http://localhost:8000';
process.env.AWS_REGION ??= 'us-east-1';
process.env.AWS_ACCESS_KEY_ID ??= 'local';
process.env.AWS_SECRET_ACCESS_KEY ??= 'local';
process.env.TABLE_NAME ??= 'aws-or-not';
process.env.AWS_LAMBDA_HTTP_ENDPOINT ??= '127.0.0.1:3000';

const { tableDefinition } = await import('../shared/db/schema.js');
const { createDocClient } = await import('../shared/db/client.js');
const { createStore } = await import('../shared/db/store.js');

await copyAssets();
const doc = createDocClient();
try {
  await doc.send(new CreateTableCommand(tableDefinition(process.env.TABLE_NAME)));
} catch (err) {
  if (err.name !== 'ResourceInUseException') throw err;
}
if (process.env.E2E_TIMER_SECONDS) {
  await createStore({ doc, tableName: process.env.TABLE_NAME }).putConfig({ hardTimerSeconds: Number(process.env.E2E_TIMER_SECONDS) });
}
await import('../game/index.js');
