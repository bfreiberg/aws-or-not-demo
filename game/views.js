import { html } from 'hono/html';
import { rankForTier } from '../shared/ranks.js';
import { roastFor } from '../shared/roasts.js';
import { shareUrls, shareText } from './public/share-urls.js';
import { TIER_SIZES } from '../shared/engine.js';

export function layout({ title, head = '', body, scripts = [], gameMode }) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#101827">
<title>${title}</title>
<link rel="stylesheet" href="/public/style.css">
${head}
</head>
<body${gameMode ? html` class="playing"` : ''}>
<a class="skip-link" href="#main">Skip to content</a>
<header class="top">
  <a class="logo" href="/">AWS <span class="logo-or">or</span> Not<span class="accent">?</span></a>
  <nav aria-label="Main navigation"><a href="/leaderboard">Leaderboard</a>${gameMode ? html`<a href="/play?mode=${gameMode}">Restart</a>` : ''}</nav>
</header>
<main id="main" tabindex="-1">${body}</main>
<footer>
  <p>Runs on AWS Lambda Web Functions. Just for fun.</p>
  <p class="disclaimer">AWS or Not? is an independent fan project. It is not affiliated with, endorsed by or sponsored by Amazon Web Services. AWS and the names of AWS services are trademarks of Amazon.com, Inc. or its affiliates.</p>
</footer>
${scripts.map((src) => html`<script type="module" src="${src}"></script>`)}
</body>
</html>`;
}

export function leaderboardTable(entries) {
  if (entries.length === 0) return html`<p class="muted">No runs yet. Be the first.</p>`;
  return html`<ol class="board">${entries.map((e) => html`<li><a href="/r/${e.id}"><span class="who">${e.handle}</span><span class="rank">${rankForTier(e.tier)}</span><span class="pts">${e.score}</span></a></li>`)}</ol>`;
}

// Inline SVG icons (no extra requests, allowed by the CSP).
const icon = (paths) => html`<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const rankIcon = icon(html`<path d="m6 14 6-5 6 5M6 19l6-5 6 5M6 9l6-5 6 5"/>`);
const normalIcon = icon(html`<path d="M12 12c-2-3-3-4-5-4a4 4 0 0 0 0 8c2 0 3-1 5-4s3-4 5-4a4 4 0 0 1 0 8c-2 0-3-1-5-4Z"/>`);
const hardIcon = icon(html`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`);
const arrowIcon = icon(html`<path d="M5 12h14m-6-6 6 6-6 6"/>`);
const STEPS = [
  {
    title: 'Real or made up?',
    text: 'Decide whether AWS actually built each service.',
    icon: icon(html`<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4.5"/><path d="M12 17.5h.01"/>`),
  },
  {
    title: 'Climb the ranks',
    text: 'Start as an intern. Each promotion brings harder names.',
    icon: icon(html`<path d="m6 15 6-6 6 6"/><path d="m6 20 6-6 6 6"/><path d="M6 10l6-6 6 6"/>`),
  },
  {
    title: 'Three strikes',
    text: 'Three wrong answers end your run. Hard mode adds a timer.',
    icon: icon(html`<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`),
  },
];

export function homePage({ boards }) {
  return layout({
    title: 'AWS or Not? Real AWS service, or made up?',
    body: html`
<section class="hero">
  <h1>Real AWS service, <span>or made up?</span></h1>
  <div class="modes">
    <a class="btn primary mode" href="/play?mode=normal"><span><span class="mode-title">${normalIcon}Play Normal</span><small>No timer</small></span><span class="mode-arrow">${arrowIcon}</span></a>
    <a class="btn mode" href="/play?mode=hard"><span><span class="mode-title">${hardIcon}Play Hard</span><small>Timed questions</small></span><span class="mode-arrow">${arrowIcon}</span></a>
  </div>
</section>
<ol class="steps">
  ${STEPS.map((step, i) => html`<li class="step">
    <div class="step-head"><span class="step-num">0${i + 1}</span><span class="step-icon">${step.icon}</span></div>
    <h2>${step.title}</h2>
    <p>${step.text}</p>
  </li>`)}
</ol>
<div class="section-heading"><h2>Leaderboard</h2><a href="/leaderboard">View all ↗</a></div>
<section class="boards">
  <div class="panel"><h2>${normalIcon}Normal</h2>${leaderboardTable(boards.normal)}</div>
  <div class="panel"><h2>${hardIcon}Hard</h2>${leaderboardTable(boards.hard)}</div>
</section>`,
  });
}

export function leaderboardPage({ boards }) {
  return layout({
    title: 'Leaderboard · AWS or Not?',
    body: html`<h1>Leaderboard</h1>
<section class="boards">
  <div class="panel"><h2>${normalIcon}Normal</h2>${leaderboardTable(boards.normal)}</div>
  <div class="panel"><h2>${hardIcon}Hard</h2>${leaderboardTable(boards.hard)}</div>
</section>`,
  });
}

export function playPage(mode) {
  return layout({
    title: 'Play · AWS or Not?',
    gameMode: mode,
    scripts: ['/public/play.js'],
    body: html`
<section id="game" data-mode="${mode}" data-tier-sizes="${JSON.stringify(TIER_SIZES)}">
  <div class="hud">
    <span class="rank-block"><span class="rank-emblem">${rankIcon}</span><span class="rank-now"></span></span>
    <span class="score">Score <b class="score-val">0</b><span class="score-plus" aria-hidden="true" hidden>+1</span></span>
    <span class="strikes" role="img" aria-label="0 of 3 strikes"></span>
  </div>
  <div class="rank-progress" role="progressbar" aria-label="Progress to next rank" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="rank-progress-fill"></div></div>
  <p class="promo" role="status" hidden></p>
  <div class="timer" hidden><div class="timer-track"><div class="timer-bar"></div></div><span class="timer-text"></span></div>
  <div class="question-stage">
    <span class="question-counter"></span>
    <h1 class="name">Loading…</h1>
  </div>
  <div class="actions">
    <div class="choices">
      <button class="btn big" data-guess="real" disabled>Real <kbd aria-hidden="true">R</kbd></button>
      <button class="btn big" data-guess="fake" disabled>Made up <kbd aria-hidden="true">F</kbd></button>
    </div>
    <button class="btn big primary next" hidden>Next</button>
  </div>
  <div class="feedback-slot">
    <div class="feedback" hidden>
      <p class="verdict" role="status"></p>
      <p class="explanation"></p>
      <p class="pct muted"></p>
    </div>
  </div>
  <p class="error" hidden>Something went wrong. <a href="/play?mode=${mode}">Start a new run</a></p>
</section>`,
  });
}

export function resultPage({ result, origin }) {
  const url = `${origin}/r/${result.id}`;
  const image = `${origin}/og/${result.id}.png`;
  const rank = rankForTier(result.tier);
  const text = shareText({ score: result.score, rank, mode: result.mode });
  const links = shareUrls({ url, text });
  return layout({
    title: `I just scored ${result.score} on AWS or Not?`,
    scripts: ['/public/share.js'],
    head: html`<meta property="og:type" content="website">
<meta property="og:url" content="${url}">
<meta property="og:title" content="I just scored ${result.score} on AWS or Not?">
<meta name="twitter:title" content="I just scored ${result.score} on AWS or Not?">
<meta property="og:description" content="${text}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${image}">`,
    body: html`
<section class="result">
  <h1>Your result</h1>
  <img class="card" src="/card/${result.id}.png" width="1200" height="630" alt="${text}">
  <a class="btn primary big cta" href="/">Play again</a>
  <p class="roast">${roastFor(result.score)}</p>
  <div class="share">
    <a class="btn" target="_blank" rel="noopener" href="${links.linkedin}">LinkedIn</a>
    <a class="btn" target="_blank" rel="noopener" href="${links.x}">X</a>
    <a class="btn" target="_blank" rel="noopener" href="${links.bluesky}">Bluesky</a>
    <button class="btn" data-copy-image="/og/${result.id}.png">Copy image</button>
    <button class="btn" data-native-share data-url="${url}" data-text="${text}" hidden>Share…</button>
  </div>
</section>`,
  });
}

export const notFoundPage = () => layout({
  title: 'Not found · AWS or Not?',
  body: html`<h1>404</h1><p>That page is as real as AWS Elastic Banana.</p><a class="btn primary" href="/">Play</a>`,
});
