import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createTestStore } from './helpers/dynamo.js';
import { createStore, ConflictError } from '../shared/db/store.js';
import { dayOf } from '../shared/http.js';

let ctx;
beforeEach(async () => {
  ctx = undefined;
  ctx = await createTestStore();
});
afterEach(async () => { await ctx?.cleanup(); });

const createdAt = Date.UTC(2026, 9, 15, 12);
const day = dayOf(createdAt);
const options = { ipHash: 'player', dailyCap: 20 };
const result = (id = 'final001') => ({
  id, handle: 'Test Otter', mode: 'normal', score: 7, tier: 2, answers: [true, false], createdAt,
});
const getItem = async (PK, SK) => (await ctx.doc.send(new GetCommand({
  TableName: ctx.tableName, Key: { PK, SK }, ConsistentRead: true,
}))).Item;
const rate = () => getItem(`RATE#player#${day}`, 'LB');
const seedRate = (count) => ctx.doc.send(new PutCommand({
  TableName: ctx.tableName, Item: { PK: `RATE#player#${day}`, SK: 'LB', count },
}));

async function expectStatistics(games, totalScore) {
  for (const d of [day, 'ALL']) {
    expect(await getItem(`DAY#${d}`, 'normal')).toMatchObject({ games, totalScore, t2: games });
  }
}

describe('atomic result finalization', () => {
  it('rolls back the result, quota and both aggregates when one aggregate cannot update', async () => {
    await seedRate(19);
    await ctx.doc.send(new PutCommand({
      TableName: ctx.tableName, Item: { PK: `DAY#${day}`, SK: 'normal', games: 'invalid' },
    }));

    await expect(ctx.store.finalizeResult(result(), options)).rejects.toThrow();
    expect(await ctx.store.getResult('final001')).toBeNull();
    expect((await rate()).count).toBe(19);
    expect(await getItem('DAY#ALL', 'normal')).toBeUndefined();
    expect((await getItem(`DAY#${day}`, 'normal')).games).toBe('invalid');

    await ctx.doc.send(new DeleteCommand({ TableName: ctx.tableName, Key: { PK: `DAY#${day}`, SK: 'normal' } }));
    await ctx.store.finalizeResult(result(), options);
    expect(await ctx.store.getResult('final001')).toEqual(result());
    expect((await rate()).count).toBe(20);
    expect(await getItem('RESULT#final001', 'META')).toHaveProperty('GSI1PK', 'LB#normal');
    await expectStatistics(1, 7);
  });

  it('allows only one concurrent completion of the same result', async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => ctx.store.finalizeResult(result(), options)));
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    const failures = attempts.filter((a) => a.status === 'rejected');
    expect(failures).toHaveLength(3);
    for (const failure of failures) expect(failure.reason).toBeInstanceOf(ConflictError);
    expect((await rate()).count).toBe(1);
    await expectStatistics(1, 7);
  });

  it('awards the last leaderboard slot once when different results finish concurrently', async () => {
    await seedRate(19);
    await Promise.all([
      ctx.store.finalizeResult(result('final001'), options),
      ctx.store.finalizeResult(result('final002'), options),
    ]);
    const items = await Promise.all(['final001', 'final002'].map((id) => getItem(`RESULT#${id}`, 'META')));
    expect(items.filter((item) => item.GSI1PK === 'LB#normal')).toHaveLength(1);
    expect((await rate()).count).toBe(21);
    await expectStatistics(2, 14);
  });

  it('does not consume another slot or count a game twice after a committed response is lost', async () => {
    await seedRate(19);
    let loseResponse = true;
    const store = createStore({
      tableName: ctx.tableName,
      doc: {
        send: async (command) => {
          const response = await ctx.doc.send(command);
          if (command.constructor.name === 'TransactWriteCommand' && loseResponse) {
            loseResponse = false;
            throw new Error('Connection closed after commit');
          }
          return response;
        },
      },
    });
    await expect(store.finalizeResult(result(), options)).rejects.toThrow('Connection closed after commit');
    await expect(store.finalizeResult(result(), options)).rejects.toBeInstanceOf(ConflictError);
    expect((await rate()).count).toBe(20);
    expect(await ctx.store.getResult('final001')).toEqual(result());
    expect(await getItem('RESULT#final001', 'META')).toHaveProperty('GSI1PK', 'LB#normal');
    await expectStatistics(1, 7);
  });

  it('keeps the existing no-IP behavior without creating a shared quota record', async () => {
    await ctx.store.finalizeResult(result(), { ...options, ipHash: null });
    expect(await getItem('RESULT#final001', 'META')).toHaveProperty('GSI1PK', 'LB#normal');
    expect(await getItem(`RATE#null#${day}`, 'LB')).toBeUndefined();
    expect(await rate()).toBeUndefined();
    await expectStatistics(1, 7);
  });
});
