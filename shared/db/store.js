import {
  BatchGetCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { MAX_TIER } from '../engine.js';
import { dayOf } from '../http.js';

export class ConflictError extends Error {}
export const DEFAULT_CONFIG = Object.freeze({ hardTimerSeconds: 10 });

const DAY_SECONDS = 86_400;
const MAX_ATTEMPTS = 6;
const RETRYABLE_TRANSACTION_CODES = new Set(['TransactionConflict', 'ThrottlingError', 'ProvisionedThroughputExceeded']);
const backoff = (attempt) => new Promise((resolve) => {
  setTimeout(resolve, Math.floor(Math.random() * Math.min(1000, 50 * 2 ** attempt)));
});
const pad = (n, width) => String(n).padStart(width, '0');

// Higher score first; on ties the earlier run wins (inverted timestamp sorts earlier-first when descending).
export const leaderboardSortKey = (score, createdAt) => `${pad(score, 6)}#${pad(9_999_999_999_999 - createdAt, 13)}`;

const strip = ({ PK, SK, GSI1PK, GSI1SK, expiresAt, ...rest }) => rest;

export function createStore({ doc, tableName }) {
  const TableName = tableName;

  async function conditional(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') throw new ConflictError(err.message);
      throw err;
    }
  }

  async function batchGet(keys, options) {
    const items = [];
    for (let i = 0; i < keys.length; i += 100) {
      let request = { [TableName]: { Keys: keys.slice(i, i + 100) } };
      for (let attempt = 0; ; attempt++) {
        const res = await doc.send(new BatchGetCommand({ RequestItems: request }), options);
        items.push(...(res.Responses?.[TableName] ?? []));
        request = res.UnprocessedKeys;
        if (!request?.[TableName]?.Keys?.length) break;
        if (attempt === MAX_ATTEMPTS - 1) throw new Error('DynamoDB batch read retry limit exceeded');
        await backoff(attempt);
      }
    }
    return items;
  }

  const runItem = (run, version) => ({
    PK: `RUN#${run.id}`,
    SK: 'META',
    ...run,
    version,
    expiresAt: Math.floor(run.createdAt / 1000) + DAY_SECONDS,
  });

  const resultItem = (result, onLeaderboard) => ({
    PK: `RESULT#${result.id}`,
    SK: 'META',
    ...result,
    ...(onLeaderboard && {
      GSI1PK: `LB#${result.mode}`,
      GSI1SK: leaderboardSortKey(result.score, result.createdAt),
    }),
  });

  const gameStatUpdate = ({ day, mode, score, tier }) => ({
    TableName,
    Key: { PK: `DAY#${day}`, SK: mode },
    UpdateExpression: 'ADD games :one, totalScore :s, #t :one',
    ExpressionAttributeNames: { '#t': `t${tier}` },
    ExpressionAttributeValues: { ':one': 1, ':s': score },
  });

  return {
    async putRun(run) {
      await conditional(() => doc.send(new PutCommand({
        TableName,
        Item: runItem(run, run.version),
        ConditionExpression: 'attribute_not_exists(PK)',
      })));
    },

    async getRun(id) {
      const { Item } = await doc.send(new GetCommand({ TableName, Key: { PK: `RUN#${id}`, SK: 'META' }, ConsistentRead: true }));
      return Item ? strip(Item) : null;
    },

    async saveRun(run, expectedVersion) {
      const item = runItem(run, expectedVersion + 1);
      await conditional(() => doc.send(new PutCommand({
        TableName,
        Item: item,
        ConditionExpression: '#v = :v',
        ExpressionAttributeNames: { '#v': 'version' },
        ExpressionAttributeValues: { ':v': expectedVersion },
      })));
      return strip(item);
    },

    async recordAnswerStat(qid, correct, options) {
      const { Attributes } = await doc.send(new UpdateCommand({
        TableName,
        Key: { PK: `QSTAT#${qid}`, SK: 'META' },
        UpdateExpression: 'ADD seen :one, correct :c',
        ExpressionAttributeValues: { ':one': 1, ':c': correct ? 1 : 0 },
        ReturnValues: 'ALL_NEW',
      }), options);
      return { seen: Attributes.seen, correct: Attributes.correct };
    },

    async getQuestionStats(qids, options) {
      const items = await batchGet(qids.map((qid) => ({ PK: `QSTAT#${qid}`, SK: 'META' })), options);
      return new Map(items.map((i) => [i.PK.slice('QSTAT#'.length), { seen: i.seen, correct: i.correct }]));
    },

    async putResult(result, { onLeaderboard }) {
      await conditional(() => doc.send(new PutCommand({
        TableName, Item: resultItem(result, onLeaderboard), ConditionExpression: 'attribute_not_exists(PK)',
      })));
    },

    async finalizeResult(result, { ipHash, dailyCap }) {
      const day = dayOf(result.createdAt);
      let onLeaderboard = true;
      for (let attempt = 0; ; attempt++) {
        const TransactItems = [
          { Put: { TableName, Item: resultItem(result, onLeaderboard), ConditionExpression: 'attribute_not_exists(PK)' } },
          ...[day, 'ALL'].map((d) => ({ Update: gameStatUpdate({ ...result, day: d }) })),
        ];
        if (ipHash != null) {
          TransactItems.push({
            Update: {
              TableName,
              Key: { PK: `RATE#${ipHash}#${day}`, SK: 'LB' },
              UpdateExpression: 'ADD #c :one SET expiresAt = :exp',
              ConditionExpression: onLeaderboard ? 'attribute_not_exists(#c) OR #c < :cap' : '#c >= :cap',
              ExpressionAttributeNames: { '#c': 'count' },
              ExpressionAttributeValues: {
                ':one': 1, ':cap': dailyCap, ':exp': Math.floor(result.createdAt / 1000) + 2 * DAY_SECONDS,
              },
            },
          });
        }
        try {
          await doc.send(new TransactWriteCommand({ TransactItems }));
          return;
        } catch (err) {
          if (err.name !== 'TransactionCanceledException') throw err;
          const reasons = err.CancellationReasons ?? [];
          // The conditional result put makes retries safe even if the previous response was lost.
          if (reasons[0]?.Code === 'ConditionalCheckFailed') throw new ConflictError(err.message);
          if (attempt === MAX_ATTEMPTS - 1) throw err;
          const quotaFailed = reasons[3]?.Code === 'ConditionalCheckFailed';
          const otherFailures = reasons.filter((reason, i) => reason.Code !== 'None' && !(i === 3 && quotaFailed));
          if (otherFailures.some((reason) => !RETRYABLE_TRANSACTION_CODES.has(reason.Code))) throw err;
          if (quotaFailed) {
            // Try the other side of the cap. No quota or statistics were changed by the failed transaction.
            onLeaderboard = !onLeaderboard;
          }
          if (otherFailures.length) await backoff(attempt);
          else if (!quotaFailed) throw err;
        }
      }
    },

    async getResult(id) {
      const { Item } = await doc.send(new GetCommand({ TableName, Key: { PK: `RESULT#${id}`, SK: 'META' }, ConsistentRead: true }));
      return Item ? strip(Item) : null;
    },

    async getLeaderboard(mode, limit) {
      const { Items } = await doc.send(new QueryCommand({
        TableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `LB#${mode}` },
        ScanIndexForward: false,
        Limit: limit,
      }));
      return (Items ?? []).map(strip);
    },

    async removeFromLeaderboard(id) {
      await conditional(() => doc.send(new UpdateCommand({
        TableName,
        Key: { PK: `RESULT#${id}`, SK: 'META' },
        UpdateExpression: 'REMOVE GSI1PK, GSI1SK',
        ConditionExpression: 'attribute_exists(PK)',
      })));
    },

    async recordGame({ day, mode, score, tier }) {
      await Promise.all([day, 'ALL'].map((d) => doc.send(new UpdateCommand(gameStatUpdate({ day: d, mode, score, tier })))));
    },

    async getDays(days, modes) {
      const keys = days.flatMap((d) => modes.map((m) => ({ PK: `DAY#${d}`, SK: m })));
      const items = await batchGet(keys);
      return items.map((i) => ({
        day: i.PK.slice('DAY#'.length),
        mode: i.SK,
        games: i.games ?? 0,
        totalScore: i.totalScore ?? 0,
        tiers: Array.from({ length: MAX_TIER }, (_, k) => i[`t${k + 1}`] ?? 0),
      }));
    },

    async getConfig() {
      const { Item } = await doc.send(new GetCommand({ TableName, Key: { PK: 'CONFIG', SK: 'META' } }));
      return { hardTimerSeconds: Item?.hardTimerSeconds ?? DEFAULT_CONFIG.hardTimerSeconds };
    },

    async putConfig({ hardTimerSeconds }) {
      await doc.send(new PutCommand({ TableName, Item: { PK: 'CONFIG', SK: 'META', hardTimerSeconds } }));
    },

    async incrementRate(ipHash, day, now) {
      const { Attributes } = await doc.send(new UpdateCommand({
        TableName,
        Key: { PK: `RATE#${ipHash}#${day}`, SK: 'LB' },
        UpdateExpression: 'ADD #c :one SET expiresAt = :exp',
        ExpressionAttributeNames: { '#c': 'count' },
        ExpressionAttributeValues: { ':one': 1, ':exp': Math.floor(now / 1000) + 2 * DAY_SECONDS },
        ReturnValues: 'UPDATED_NEW',
      }));
      return Attributes.count;
    },
  };
}
