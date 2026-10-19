import { loadQuestionStats } from './question-stats.js';
const root = document.getElementById('game');
const mode = root.dataset.mode;
const $ = (sel) => root.querySelector(sel);
const tierSizes = JSON.parse(root.dataset.tierSizes);
let run = null;
let question = null;
let busy = false;
let timer = null;
let promotionTimer = null;
let scoreTimer = null;

function setBusy(value) {
  busy = value;
  const disabled = value || !question || !$('.error').hidden;
  for (const button of root.querySelectorAll('.actions button')) button.disabled = disabled;
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail() {
  stopTimer();
  $('.error').hidden = false;
  setBusy(false);
}

function renderHud(score, strikes, correct = false) {
  $('.score-val').textContent = score;
  $('.strikes').replaceChildren(...Array.from({ length: 3 }, (_, index) => {
    const strike = document.createElement('span');
    strike.className = index < strikes ? 'strike lost' : 'strike';
    strike.textContent = index < strikes ? '✖' : '○';
    return strike;
  }));
  $('.strikes').setAttribute('aria-label', `${strikes} of 3 strikes`);
  if (correct) {
    clearTimeout(scoreTimer);
    $('.score-plus').hidden = false;
    replay($('.score-plus'), 'show');
    scoreTimer = setTimeout(() => { $('.score-plus').hidden = true; }, 800);
  }
}

function renderProgress(answered = false) {
  const size = tierSizes[question.tier - 1];
  const start = tierSizes.slice(0, question.tier - 1).reduce((total, value) => total + value, 0);
  const count = question.number - 1 + Number(answered) - start;
  const fraction = size ? Math.min(1, Math.max(0, count / size)) : 1;
  const progress = $('.rank-progress');
  const description = size ? `${Math.max(0, size - count)} questions to next rank` : 'Top rank';
  $('.rank-progress-fill').style.transform = `scaleX(${fraction})`;
  progress.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
  progress.setAttribute('aria-valuetext', description);
  progress.title = description;
}

function stopTimer() {
  clearInterval(timer);
  timer = null;
}

function startTimer(seconds) {
  stopTimer();
  const deadline = Date.now() + seconds * 1000;
  $('.timer').hidden = false;
  const tick = () => {
    const left = Math.max(0, deadline - Date.now());
    $('.timer-text').textContent = `${(left / 1000).toFixed(1)}s`;
    $('.timer-bar').style.transform = `scaleX(${left / (seconds * 1000)})`;
    $('.timer').classList.toggle('urgent', left <= 3000);
    if (left === 0) answer('timeout');
  };
  tick();
  timer = setInterval(tick, 100);
}

// Restart a CSS animation by removing the class and forcing a reflow before re-adding it.
function replay(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

// The badge floats over the HUD (absolute, no pointer events), so it never moves the buttons.
function celebrate(rank) {
  const promo = $('.promo');
  clearTimeout(promotionTimer);
  promo.replaceChildren(
    Object.assign(document.createElement('small'), { textContent: 'Promoted!' }),
    Object.assign(document.createElement('span'), { textContent: rank }),
  );
  promo.hidden = false;
  replay(promo, 'show');
  replay($('.rank-now'), 'bump');
  // Keep the badge transient even when reduced motion disables CSS animations.
  promotionTimer = setTimeout(() => { promo.hidden = true; }, 2200);
}

function showQuestion(q) {
  const promoted = question !== null && q.tier > question.tier;
  question = q;
  $('.rank-now').textContent = q.rank;
  $('.rank-now').title = q.rank;
  if (promoted) celebrate(q.rank);
  $('.name').textContent = q.name;
  $('.question-counter').textContent = `Question ${q.number}`;
  delete $('.question-stage').dataset.verdict;
  renderProgress();
  $('.feedback').hidden = true;
  $('.next').hidden = true;
  $('.choices').hidden = false;
  setBusy(busy);
  if (run.timerSeconds) startTimer(run.timerSeconds);
}

async function answer(guess) {
  if (busy || !run || !question || $('.choices').hidden || !$('.error').hidden) return;
  setBusy(true);
  stopTimer();
  try {
    const path = `/api/runs/${run.runId}/answer`;
    let res = await post(path, { qid: question.qid, guess });
    if (res.status === 429) {
      await sleep(450);
      res = await post(path, { qid: question.qid, guess });
    }
    if (res.status >= 500) {
      // Server error after saving: ask the server what state we're in
      const recovery = await post(`/api/runs/${run.runId}/next`);
      if (recovery.status === 200 && recovery.data.gameOver) return showOver(recovery.data);
      if (recovery.status === 200 && recovery.data.question) return showQuestion(recovery.data.question);
      return fail();
    }
    if (res.status !== 200) return fail();

    const d = res.data;
    renderHud(d.score, d.strikes, d.correct);
    renderProgress(true);
    $('.choices').hidden = true;
    const truth = d.real ? 'real' : 'made up';
    const verdictIcon = Object.assign(document.createElement('span'), { textContent: d.correct ? '✓' : '✕' });
    verdictIcon.setAttribute('aria-hidden', 'true');
    $('.verdict').replaceChildren(
      verdictIcon,
      document.createTextNode(d.timedOut ? `Time's up! It's ${truth}.` : `${d.correct ? 'Correct' : 'Wrong'}: it's ${truth}.`),
    );
    $('.verdict').className = `verdict ${d.correct ? 'good' : 'bad'}`;
    $('.question-stage').dataset.verdict = d.correct ? 'good' : 'bad';
    $('.feedback').classList.toggle('bad', !d.correct);
    $('.explanation').textContent = d.explanation;
    $('.pct').hidden = true;
    $('.feedback').hidden = false;
    $('.next').hidden = false;
    $('.next').textContent = d.gameOver ? 'See result' : 'Next';
    $('.next').onclick = d.gameOver ? () => showOver(d) : next;
    setBusy(false);
    $('.next').focus({ preventScroll: true });
    const answeredQid = question.qid;
    void loadQuestionStats(answeredQid, $('.pct'), () => question.qid === answeredQid && !$('.feedback').hidden);
  } catch {
    fail();
  } finally {
    setBusy(false);
  }
}

async function next() {
  if (busy || !run || !question || $('.next').hidden || !$('.error').hidden) return;
  setBusy(true);
  try {
    let res = await post(`/api/runs/${run.runId}/next`);
    if (res.status === 409) res = await post(`/api/runs/${run.runId}/next`);
    if (res.status !== 200) return fail();
    if (res.data.gameOver) return showOver(res.data);
    showQuestion(res.data.question);
    document.getElementById('main').focus({ preventScroll: true });
  } catch {
    fail();
  } finally {
    setBusy(false);
  }
}

// Game over goes straight to the shareable result page.
function showOver(d) {
  stopTimer();
  location.assign(`/r/${d.resultId}`);
}

for (const b of root.querySelectorAll('[data-guess]')) b.addEventListener('click', () => answer(b.dataset.guess));
document.addEventListener('keydown', (e) => {
  if (e.repeat || e.altKey || e.ctrlKey || e.metaKey || !question || $('.choices').hidden) return;
  if (e.target.closest('input, textarea, select, [contenteditable="true"], a')) return;
  const key = e.key.toLowerCase();
  if (key === 'r' || e.key === 'ArrowLeft') { e.preventDefault(); answer('real'); }
  if (key === 'f' || e.key === 'ArrowRight') { e.preventDefault(); answer('fake'); }
});

(async () => {
  try {
    const res = await post('/api/runs', { mode });
    if (res.status !== 201) return fail();
    run = res.data;
    renderHud(0, 0);
    showQuestion(run.question);
  } catch {
    fail();
  }
})();
