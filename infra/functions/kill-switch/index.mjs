import { LambdaWebClient, UpdateWebFunctionEndpointCommand } from '@aws-sdk/client-lambda-web';

const ENDPOINTS = [
  { functionName: 'aws-or-not-game', endpointName: 'default' },
  { functionName: 'aws-or-not-admin', endpointName: 'default' },
];

/**
 * Creates a handler with an injected LambdaWebClient (for testability).
 * @param {{ client: LambdaWebClient }} deps
 */
export function createHandler({ client }) {
  return async function handler(event) {
    console.log('Kill switch triggered', JSON.stringify({ source: event?.Records?.[0]?.Sns?.Subject ?? 'unknown' }));

    const errors = [];
    for (const { functionName, endpointName } of ENDPOINTS) {
      try {
        const cmd = new UpdateWebFunctionEndpointCommand({
          functionName,
          endpointName,
          throttleConfig: { rateLimit: 0 },
        });
        await client.send(cmd);
        console.log('Throttled to 0', JSON.stringify({ functionName, endpointName }));
      } catch (err) {
        console.error('Failed to throttle', JSON.stringify({ functionName, endpointName, error: String(err) }));
        errors.push({ functionName, endpointName, error: String(err) });
      }
    }

    if (errors.length > 0) {
      throw new Error(`Kill switch failed for: ${errors.map((e) => e.functionName).join(', ')}`);
    }
  };
}

const defaultClient = new LambdaWebClient({});
export const handler = createHandler({ client: defaultClient });
