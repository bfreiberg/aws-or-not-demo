import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { startRun, gradeAnswer, nextQuestion } from '../shared/engine.js';
import { rankForTier } from '../shared/ranks.js';
import { ConflictError } from '../shared/db/store.js';
import { clientIp } from '../shared/http.js';
import { createQuestionStatsRecorder } from './question-stats.js';

export const LEADERBOARD_DAILY_CAP = 20;
export const RESULT_ID = /^[A-Za-z0-9_-]{8}$/;
const RUN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ERROR_STATUS = { stale: 409, too_fast: 429, finished: 410, invalid: 400 };

const fail = (result, c) => (result.success ? undefined : c.json({ error: 'invalid' }, 400));
const runParam = zValidator('param', z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{8,32}$/) }), fail);

export function apiRoutes({ store, questions, config, now, rng, newRunId, newResultId, hashIp, generateHandle }) {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const api = new Hono();
  const recordStats = createQuestionStatsRecorder(store);

  const publicQuestion = (run) => ({
    qid: run.currentQid,
    name: byId.get(run.currentQid).name,
    number: run.questionNumber,
    tier: run.tier,
    rank: rankForTier(run.tier),
  });

  async function finalize(run, t) {
    const resultId = run.resultId;
    const existing = await store.getResult(resultId);
    const payload = { gameOver: true, resultId, rank: rankForTier(run.tier), score: run.score, strikes: run.strikes };
    if (existing) return payload;

    if (run.ipHash == null) {
      console.warn(JSON.stringify({ level: 'warn', message: 'no client ip; leaderboard cap skipped' }));
    }

    const result = {
      id: resultId,
      handle: run.handle,
      mode: run.mode,
      score: run.score,
      tier: run.tier,
      answers: run.answers.slice(-10),
      // Names of the questions answered wrong (or timed out); answers[i] belongs to usedQids[i].
      misses: run.usedQids
        .filter((_, i) => run.answers[i] === false)
        .map((qid) => byId.get(qid))
        .filter(Boolean)
        .map((q) => ({ name: q.name, real: q.real, ...(run.timedOutQids?.includes(q.id) && { timedOut: true }) })),
      createdAt: t,
    };
    try {
      await store.finalizeResult(result, { ipHash: run.ipHash, dailyCap: LEADERBOARD_DAILY_CAP });
    } catch (err) {
      if (err instanceof ConflictError) return payload;
      throw err;
    }
    return payload;
  }

  async function loadActiveRun(c) {
    const run = await store.getRun(c.req.valid('param').id);
    if (!run) return { response: c.json({ error: 'not_found' }, 404) };
    if (run.finished && run.resultId) return { response: c.json(await finalize(run, now())) };
    if (run.finished || now() - run.createdAt > RUN_MAX_AGE_MS) return { response: c.json({ error: 'gone' }, 410) };
    return { run };
  }

  async function save(run, expectedVersion, c) {
    try {
      return { saved: await store.saveRun(run, expectedVersion) };
    } catch (err) {
      if (err instanceof ConflictError) return { response: c.json({ error: 'conflict' }, 409) };
      throw err;
    }
  }

  api.get('/questions/:qid/stats', async (c) => {
    const qid = c.req.param('qid');
    if (!byId.has(qid)) return c.json({ error: 'not_found' }, 404);
    try {
      const stats = await store.getQuestionStats([qid], { abortSignal: AbortSignal.timeout(1000) });
      const stat = stats.get(qid);
      return c.json({ pctCorrect: stat?.seen > 0 ? Math.round((100 * stat.correct) / stat.seen) : null });
    } catch (err) {
      console.warn(JSON.stringify({ level: 'warn', message: 'question stats read failed', qid, error: err.message }));
      return c.json({ pctCorrect: null });
    }
  });

  api.post('/runs', zValidator('json', z.object({ mode: z.enum(['normal', 'hard']) }), fail), async (c) => {
    const { mode } = c.req.valid('json');
    const { hardTimerSeconds } = await config.get();
    const ip = clientIp(c);
    const run = startRun({
      id: newRunId(),
      mode,
      handle: generateHandle(rng),
      ipHash: ip !== 'unknown' ? hashIp(ip) : null,
      timerSeconds: hardTimerSeconds,
      now: now(),
      questions,
      rng,
    });
    await store.putRun(run);
    return c.json({
      runId: run.id, handle: run.handle, mode, timerSeconds: run.timerSeconds,
      score: 0, strikes: 0, question: publicQuestion(run),
    }, 201);
  });

  api.post(
    '/runs/:id/answer',
    runParam,
    zValidator('json', z.object({ qid: z.string().max(64), guess: z.enum(['real', 'fake', 'timeout']) }), fail),
    async (c) => {
      const { run, response } = await loadActiveRun(c);
      if (response) return response;
      const body = c.req.valid('json');
      const question = byId.get(body.qid);
      if (!question) return c.json({ error: 'stale' }, 409);

      const t = now();
      const graded = gradeAnswer(run, body, { question, now: t });
      if (graded.error) return c.json({ error: graded.error }, ERROR_STATUS[graded.error]);

      if (graded.run.finished) graded.run.resultId = newResultId();

      const { saved, response: conflict } = await save(graded.run, run.version, c);
      if (conflict) return conflict;

      recordStats(question.id, graded.correct);
      const feedback = {
        correct: graded.correct,
        timedOut: graded.timedOut,
        real: question.real,
        explanation: question.explanation,
        score: saved.score,
        strikes: saved.strikes,
      };
      if (!saved.finished) return c.json(feedback);
      return c.json({ ...feedback, ...(await finalize(saved, t)) });
    },
  );

  api.post('/runs/:id/next', runParam, async (c) => {
    const { run, response } = await loadActiveRun(c);
    if (response) return response;
    if (run.currentQid !== null) return c.json({ question: publicQuestion(run) });

    const t = now();
    const nextRun = nextQuestion(run, questions, t, rng);
    if (nextRun.finished) nextRun.resultId = newResultId();

    const { saved, response: conflict } = await save(nextRun, run.version, c);
    if (conflict) return conflict;
    if (saved.finished) {
      return c.json({ score: saved.score, strikes: saved.strikes, ...(await finalize(saved, t)) });
    }
    return c.json({ question: publicQuestion(saved) });
  });

  return api;
}
