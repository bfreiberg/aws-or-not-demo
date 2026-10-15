// Optional feedback: a slow or failed request must not affect answering or advancing.
export async function loadQuestionStats(qid, element, isCurrent) {
  try {
    const response = await fetch(`/api/questions/${encodeURIComponent(qid)}/stats`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return;
    const { pctCorrect } = await response.json();
    if (!isCurrent() || !Number.isFinite(pctCorrect) || pctCorrect < 0 || pctCorrect > 100) return;
    element.textContent = `${pctCorrect}% of players got this right.`;
    element.hidden = false;
  } catch {
    // Keep the percentage hidden; the accepted answer's feedback is already visible.
  }
}
