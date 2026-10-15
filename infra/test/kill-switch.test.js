import { describe, it, expect, vi } from 'vitest';
import { createHandler } from '../functions/kill-switch/index.mjs';

/** Build a fake LambdaWebClient that captures UpdateWebFunctionEndpoint calls. */
function makeFakeClient({ failFunctionName } = {}) {
  const calls = [];
  const client = {
    send: vi.fn(async (cmd) => {
      const input = cmd.input;
      calls.push(input);
      if (failFunctionName && input.functionName === failFunctionName) {
        throw new Error(`Simulated failure for ${input.functionName}`);
      }
      return {};
    }),
  };
  return { client, calls };
}

describe('kill-switch handler', () => {
  it('throttles both endpoints to rateLimit 0', async () => {
    const { client, calls } = makeFakeClient();
    const handler = createHandler({ client });

    await handler({});

    expect(calls).toHaveLength(2);

    const game = calls.find((c) => c.functionName === 'aws-or-not-game');
    expect(game).toBeDefined();
    expect(game.endpointName).toBe('default');
    expect(game.throttleConfig.rateLimit).toBe(0);

    const admin = calls.find((c) => c.functionName === 'aws-or-not-admin');
    expect(admin).toBeDefined();
    expect(admin.endpointName).toBe('default');
    expect(admin.throttleConfig.rateLimit).toBe(0);
  });

  it('is idempotent — calling twice sends 4 total update commands', async () => {
    const { client, calls } = makeFakeClient();
    const handler = createHandler({ client });

    await handler({});
    await handler({});

    expect(calls).toHaveLength(4);
  });

  it('still attempts the second endpoint when the first fails, then throws', async () => {
    const { client, calls } = makeFakeClient({ failFunctionName: 'aws-or-not-game' });
    const handler = createHandler({ client });

    await expect(handler({})).rejects.toThrow('aws-or-not-game');

    // Both endpoints must have been attempted
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.functionName === 'aws-or-not-admin')).toBe(true);
  });
});
