import { html } from 'hono/html';
import { rankForTier } from '../shared/ranks.js';

const layout = ({ title, body, admin }) => html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · AWS or Not? admin</title>
<link rel="stylesheet" href="/admin/public/admin.css">
</head>
<body>
<header><strong>AWS or Not? admin</strong><nav><a href="/admin">Dashboard</a><a href="/admin/config">Config</a><span>${admin?.email ?? ''}</span><a href="/admin/logout">Sign out</a></nav></header>
<main>${body}</main>
<script type="module" src="/admin/public/admin.js"></script>
</body>
</html>`;

const questionTable = (rows) => rows.length === 0
  ? html`<p class="muted">Not enough data yet.</p>`
  : html`<table><tr><th>Name</th><th>Real?</th><th>Seen</th><th>% correct</th></tr>
${rows.map((q) => html`<tr><td>${q.name}</td><td>${q.real ? 'real' : 'fake'}</td><td>${q.seen}</td><td>${q.pct}%</td></tr>`)}</table>`;

const boardTable = (entries) => entries.length === 0
  ? html`<p class="muted">Empty.</p>`
  : html`<table><tr><th>#</th><th>Handle</th><th>Score</th><th>Rank</th><th></th></tr>
${entries.map((e, i) => html`<tr><td>${i + 1}</td><td><a href="#" title="${e.id}">${e.handle}</a></td><td>${e.score}</td><td>${rankForTier(e.tier)}</td><td><button data-remove="${e.id}">Remove</button></td></tr>`)}</table>`;

export function dashboardPage(d, admin) {
  return layout({
    title: 'Dashboard',
    admin,
    body: html`
<h1>Dashboard</h1>
<table><tr><th>Mode</th><th>Today</th><th>7 days</th><th>All-time</th><th>Avg score</th><th>Best</th></tr>
${Object.entries(d.perMode).map(([mode, m]) => html`<tr><td>${mode}</td><td>${m.today}</td><td>${m.week}</td><td>${m.allTime}</td><td>${m.avgScore}</td><td>${m.best}</td></tr>`)}
</table>
<h2>Rank reached (all-time)</h2>
<table>${d.rankDistribution.map((r) => html`<tr><td>${r.rank}</td><td>${r.count}</td></tr>`)}</table>
<div class="cols">
  <section><h2>Hardest questions</h2>${questionTable(d.hardest)}</section>
  <section><h2>Easiest questions</h2>${questionTable(d.easiest)}</section>
</div>
<div class="cols">
  <section><h2>Leaderboard: normal</h2>${boardTable(d.leaderboards.normal)}</section>
  <section><h2>Leaderboard: hard</h2>${boardTable(d.leaderboards.hard)}</section>
</div>`,
  });
}

export function configPage(config, admin) {
  return layout({
    title: 'Config',
    admin,
    body: html`
<h1>Config</h1>
<form id="config-form">
  <label>Hard mode timer (seconds, 3–60)
    <input name="hardTimerSeconds" type="number" min="3" max="60" step="1" required value="${config.hardTimerSeconds}">
  </label>
  <button type="submit">Save</button>
  <p id="config-status" class="muted">Changes reach the game within about 30 seconds. Runs already in progress keep their timer.</p>
</form>`,
  });
}
