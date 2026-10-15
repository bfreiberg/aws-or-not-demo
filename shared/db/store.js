import {
  BatchGetCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { MAX_TIER } from '../engine.js';

export class ConflictError extends Error {}
export const DEFAULT_CONFIG = Object.freeze({ hardTimerSeconds: 10 });

const DAY_SECONDS = 86_400;
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

  async function batchGet(keys) {
    const items = [];
    for (let i = 0; i < keys.length; i += 100) {
      let request = { [TableName]: { Keys: keys.slice(i, i + 100) } };
      while (request && Object.keys(request).length > 0) {
        const res = await doc.send(new BatchGetCommand({ RequestItems: request }));
        items.push(...(res.Responses?.[TableName] ?? []));
        request = res.UnprocessedKeys;
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

    async recordAnswerStat(qid, correct) {
      const { Attributes } = await doc.send(new UpdateCommand({
        TableName,
        Key: { PK: `QSTAT#${qid}`, SK: 'META' },
        UpdateExpression: 'ADD seen :one, correct :c',
        ExpressionAttributeValues: { ':one': 1, ':c': correct ? 1 : 0 },
        ReturnValues: 'ALL_NEW',
      }));
      return { seen: Attributes.seen, correct: Attributes.correct };
    },

    async getQuestionStats(qids) {
      const items = await batchGet(qids.map((qid) => ({ PK: `QSTAT#${qid}`, SK: 'META' })));
      return new Map(items.map((i) => [i.PK.slice('QSTAT#'.length), { seen: i.seen, correct: i.correct }]));
    },

    async putResult(result, { onLeaderboard }) {
      const item = { PK: `RESULT#${result.id}`, SK: 'META', ...result };
      if (onLeaderboard) {
        item.GSI1PK = `LB#${result.mode}`;
        item.GSI1SK = leaderboardSortKey(result.score, result.createdAt);
      }
      await conditional(() => doc.send(new PutCommand({ TableName, Item: item, ConditionExpression: 'attribute_not_exists(PK)' })));
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
      await Promise.all([day, 'ALL'].map((d) => doc.send(new UpdateCommand({
        TableName,
        Key: { PK: `DAY#${d}`, SK: mode },
        UpdateExpression: 'ADD games :one, totalScore :s, #t :one',
        ExpressionAttributeNames: { '#t': `t${tier}` },
        ExpressionAttributeValues: { ':one': 1, ':s': score },
      }))));
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
