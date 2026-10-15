function flash(el, label) {
  const original = el.textContent;
  el.textContent = label;
  setTimeout(() => { el.textContent = original; }, 1500);
}

async function copyImage(el) {
  const url = el.dataset.copyImage;
  try {
    if (!window.ClipboardItem || !navigator.clipboard?.write) throw new Error('unsupported');
    // Pass a promise, not a blob: Safari requires the write to start inside the click handler.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': fetch(url).then((r) => r.blob()) })]);
    flash(el, 'Copied!');
  } catch {
    const a = Object.assign(document.createElement('a'), { href: url, download: 'aws-or-not.png' });
    document.body.append(a);
    a.click();
    a.remove();
    flash(el, 'Downloaded');
  }
}

document.addEventListener('click', (e) => {
  const copy = e.target.closest('[data-copy-image]');
  if (copy) copyImage(copy);
  const share = e.target.closest('[data-native-share]');
  if (share) navigator.share({ url: share.dataset.url, text: share.dataset.text }).catch(() => {});
});

for (const el of document.querySelectorAll('[data-native-share]')) el.hidden = !navigator.share;
