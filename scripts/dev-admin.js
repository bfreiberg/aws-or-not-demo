// Runs the admin locally against the *deployed* Cognito pool and table (read from CDK outputs).
// Requires AWS credentials: AWS_PROFILE=<profile> npm run dev:admin
import { readFile } from 'node:fs/promises';
import { copyAssets } from './assets.js';

const outputs = JSON.parse(await readFile('dist/app-outputs.json', 'utf8')).AwsOrNotApp;
process.env.AWS_REGION ??= 'us-east-1';
process.env.AWS_LAMBDA_HTTP_ENDPOINT ??= '127.0.0.1:3001';
process.env.TABLE_NAME ??= outputs.TableName;
process.env.USER_POOL_ID ??= outputs.UserPoolId;
process.env.COGNITO_DOMAIN ??= outputs.CognitoDomain;
process.env.CLIENT_ID_PARAM ??= '/quiz-aws-or-not/admin-client-id';
await copyAssets();
await import('../admin/index.js');
