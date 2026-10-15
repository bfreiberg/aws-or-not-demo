
const root = document.getElementById('game');
const mode = root.dataset.mode;
const $ = (sel) => root.querySelector(sel);
let run = null;
let question = null;
let busy = false;
let timer = null;

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
}

function renderHud(score, strikes) {
  $('.score-val').textContent = score;
  $('.strikes').textContent = '✖'.repeat(strikes) + '○'.repeat(Math.max(0, 3 - strikes));
}

function stopTimer() {
  clearInterval(timer);
  timer = null;
}

function startTimer(seconds) {
  stopTimer();
  const deadline = Date.now() + seconds * 1000;
  $('.timer').hidden = false;
  timer = setInterval(() => {
    const left = Math.max(0, deadline - Date.now());
    $('.timer-text').textContent = `${(left / 1000).toFixed(1)}s`;
    $('.timer-bar').style.width = `${(left / (seconds * 1000)) * 100}%`;
    if (left === 0) answer('timeout');
  }, 100);
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
  promo.replaceChildren(
    Object.assign(document.createElement('small'), { textContent: 'Promoted!' }),
    Object.assign(document.createElement('span'), { textContent: rank }),
  );
  promo.hidden = false;
  replay(promo, 'show');
  replay($('.rank-now'), 'bump');
}

$('.promo').addEventListener('animationend', (e) => {
  if (e.animationName === 'promo-pop') e.currentTarget.hidden = true;
});

function showQuestion(q) {
  const promoted = question !== null && q.tier > question.tier;
  question = q;
  $('.rank-now').textContent = q.rank;
  $('.rank-now').title = q.rank;
  if (promoted) celebrate(q.rank);
  $('.name').textContent = q.name;
  $('.feedback').hidden = true;
  $('.next').hidden = true;
  $('.choices').hidden = false;
  if (run.timerSeconds) startTimer(run.timerSeconds);
}

async function answer(guess) {
  if (busy) return;
  busy = true;
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
    renderHud(d.score, d.strikes);
    $('.choices').hidden = true;
    const truth = d.real ? 'real' : 'made up';
    $('.verdict').textContent = d.timedOut ? `Time's up! It's ${truth}.` : `${d.correct ? 'Correct' : 'Wrong'}: it's ${truth}.`;
    $('.verdict').className = `verdict ${d.correct ? 'good' : 'bad'}`;
    $('.explanation').textContent = d.explanation;
    $('.pct').textContent = `${d.pctCorrect}% of players got this right.`;
    $('.feedback').hidden = false;
    $('.next').hidden = false;
    $('.next').textContent = d.gameOver ? 'See result' : 'Next';
    $('.next').onclick = d.gameOver ? () => showOver(d) : next;
    $('.next').focus();
  } catch {
    fail();
  } finally {
    busy = false;
  }
}

async function next() {
  if (busy) return;
  busy = true;
  try {
    let res = await post(`/api/runs/${run.runId}/next`);
    if (res.status === 409) res = await post(`/api/runs/${run.runId}/next`);
    if (res.status !== 200) return fail();
    if (res.data.gameOver) return showOver(res.data);
    showQuestion(res.data.question);
  } catch {
    fail();
  } finally {
    busy = false;
  }
}

// Game over goes straight to the shareable result page.
function showOver(d) {
  stopTimer();
  location.assign(`/r/${d.resultId}`);
}

for (const b of root.querySelectorAll('[data-guess]')) b.addEventListener('click', () => answer(b.dataset.guess));
document.addEventListener('keydown', (e) => {
  if ($('.choices').hidden) return;
  if (e.key === 'r' || e.key === 'ArrowLeft') answer('real');
  if (e.key === 'f' || e.key === 'ArrowRight') answer('fake');
});

(async () => {
  const res = await post('/api/runs', { mode });
  if (res.status !== 201) return fail();
  run = res.data;
  renderHud(0, 0);
  showQuestion(run.question);
})();
