const MAX_IN_FLIGHT = 32;
const WRITE_TIMEOUT_MS = 1000;

// Analytics are best-effort. Bound outstanding writes so a slow database cannot build an unbounded queue.
export function createQuestionStatsRecorder(store) {
  let inFlight = 0;
  return (qid, correct) => {
    if (inFlight >= MAX_IN_FLIGHT) {
      console.warn(JSON.stringify({ level: 'warn', message: 'question stats update skipped; at capacity', qid }));
      return;
    }
    inFlight++;
    void Promise.resolve()
      .then(() => store.recordAnswerStat(qid, correct, { abortSignal: AbortSignal.timeout(WRITE_TIMEOUT_MS) }))
      .catch((err) => {
        console.warn(JSON.stringify({ level: 'warn', message: 'question stats update failed', qid, error: err.message }));
      })
      .finally(() => { inFlight--; });
  };
}
