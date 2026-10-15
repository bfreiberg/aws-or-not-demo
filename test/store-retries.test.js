import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStore, ConflictError } from '../shared/db/store.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const tableName = 'test-retries';
const item = (id) => ({ PK: `QSTAT#${id}`, SK: 'META', seen: 2, correct: 1 });
const pending = (id) => ({ [tableName]: { Keys: [{ PK: `QSTAT#${id}`, SK: 'META' }] } });

describe('batch read retries', () => {
  it('waits before retrying only unprocessed keys, retaining previous results', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ Responses: { [tableName]: [item('first')] }, UnprocessedKeys: pending('second') })
      .mockResolvedValueOnce({ Responses: { [tableName]: [item('second')] } });
    const reading = createStore({ doc: { send }, tableName }).getQuestionStats(['first', 'second']);
    await vi.advanceTimersByTimeAsync(24);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await reading).toEqual(new Map([
      ['first', { seen: 2, correct: 1 }],
      ['second', { seen: 2, correct: 1 }],
    ]));
    expect(send.mock.calls[1][0].input.RequestItems).toEqual(pending('second'));
  });

  it('stops after a bounded number of exponentially delayed retries', async () => {
    const timestamps = [];
    const send = vi.fn(async () => {
      timestamps.push(Date.now());
      return { UnprocessedKeys: pending('blocked') };
    });
    const reading = createStore({ doc: { send }, tableName }).getQuestionStats(['blocked']);
    const rejected = expect(reading).rejects.toThrow('DynamoDB batch read retry limit exceeded');
    await vi.runAllTimersAsync();
    await rejected;
    expect(send).toHaveBeenCalledTimes(6);
    expect(timestamps.slice(1).map((t, i) => t - timestamps[i])).toEqual([25, 50, 100, 200, 400]);
  });

  it('accepts an empty unprocessed-key list without issuing another request', async () => {
    const send = vi.fn().mockResolvedValue({ Responses: { [tableName]: [item('done')] }, UnprocessedKeys: { [tableName]: { Keys: [] } } });
    expect((await createStore({ doc: { send }, tableName }).getQuestionStats(['done'])).size).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

const result = { id: 'result01', mode: 'normal', score: 1, tier: 1, createdAt: Date.UTC(2026, 9, 15) };
const options = { ipHash: 'player', dailyCap: 20 };
const cancellation = (codes) => Object.assign(new Error('Transaction canceled'), {
  name: 'TransactionCanceledException',
  CancellationReasons: codes.map((Code) => ({ Code })),
});

describe('finalization retries', () => {
  it('saves an over-cap result without a leaderboard entry while preserving quota and aggregate updates', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(cancellation(['None', 'None', 'None', 'ConditionalCheckFailed']))
      .mockResolvedValueOnce({});
    await createStore({ doc: { send }, tableName }).finalizeResult(result, options);
    expect(send).toHaveBeenCalledTimes(2);
    const [eligible, overCap] = send.mock.calls.map(([command]) => command.input.TransactItems);
    expect(eligible[0].Put.Item.GSI1PK).toBe('LB#normal');
    expect(overCap[0].Put.Item).not.toHaveProperty('GSI1PK');
    expect(overCap[0].Put.Item).not.toHaveProperty('GSI1SK');
    expect(overCap.slice(1).map(({ Update }) => Update.Key.PK)).toEqual([
      'DAY#2026-10-15', 'DAY#ALL', 'RATE#player#2026-10-15',
    ]);
    expect(overCap[3].Update.ConditionExpression).toBe('#c >= :cap');
    expect(overCap[3].Update.ExpressionAttributeValues[':cap']).toBe(20);
  });

  it.each(['TransactionConflict', 'ThrottlingError', 'ProvisionedThroughputExceeded'])('retries %s with backoff', async (code) => {
    const send = vi.fn()
      .mockRejectedValueOnce(cancellation(['None', code, 'None', 'None']))
      .mockResolvedValueOnce({});
    const writing = createStore({ doc: { send }, tableName }).finalizeResult(result, options);
    await vi.advanceTimersByTimeAsync(24);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await writing;
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('stops retrying persistent transaction conflicts', async () => {
    const error = cancellation(['None', 'TransactionConflict', 'None', 'None']);
    const send = vi.fn().mockRejectedValue(error);
    const writing = createStore({ doc: { send }, tableName }).finalizeResult(result, options);
    const rejected = expect(writing).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await rejected;
    expect(send).toHaveBeenCalledTimes(6);
  });

  it('does not mistake a malformed aggregate for an exhausted quota', async () => {
    const error = cancellation(['None', 'ValidationError', 'None', 'None']);
    const send = vi.fn().mockRejectedValue(error);
    await expect(createStore({ doc: { send }, tableName }).finalizeResult(result, options)).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('prioritizes an existing result over a failed quota condition', async () => {
    const send = vi.fn().mockRejectedValue(cancellation(['ConditionalCheckFailed', 'None', 'None', 'ConditionalCheckFailed']));
    await expect(createStore({ doc: { send }, tableName }).finalizeResult(result, options)).rejects.toBeInstanceOf(ConflictError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('propagates cancellation without reasons instead of claiming success', async () => {
    const error = Object.assign(new Error('Transaction canceled'), { name: 'TransactionCanceledException' });
    const send = vi.fn().mockRejectedValue(error);
    await expect(createStore({ doc: { send }, tableName }).finalizeResult(result, options)).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not retry a quota failure when another operation has a permanent error', async () => {
    const error = cancellation(['None', 'ValidationError', 'None', 'ConditionalCheckFailed']);
    const send = vi.fn().mockRejectedValue(error);
    await expect(createStore({ doc: { send }, tableName }).finalizeResult(result, options)).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
