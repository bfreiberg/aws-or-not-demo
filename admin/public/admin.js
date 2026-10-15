const post = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-requested-with': 'aws-or-not' },
  body: JSON.stringify(body ?? {}),
});

document.querySelector('#config-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const hardTimerSeconds = Number(new FormData(e.target).get('hardTimerSeconds'));
  const res = await post('/admin/api/config', { hardTimerSeconds });
  document.querySelector('#config-status').textContent = res.ok
    ? 'Saved. Live within about 30 seconds.'
    : 'Rejected: use a whole number from 3 to 60.';
});

document.addEventListener('click', async (e) => {
  const button = e.target.closest('[data-remove]');
  if (!button || !confirm('Remove this entry from the leaderboard? The result page stays online.')) return;
  const res = await post(`/admin/api/leaderboard/${button.dataset.remove}/remove`);
  if (res.ok) button.closest('tr').remove();
  else alert('Remove failed.');
});
