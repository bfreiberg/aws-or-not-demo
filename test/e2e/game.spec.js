import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const questions = JSON.parse(readFileSync(new URL('../../game/assets/questions.json', import.meta.url), 'utf8'));
const byName = new Map(questions.map((q) => [q.name, q]));

async function answer(page, correct) {
  const name = (await page.locator('#game .name').textContent()).trim();
  const q = byName.get(name);
  expect(q, `unknown question "${name}"`).toBeTruthy();
  await page.waitForTimeout(450); // stay above the 400ms minimum answer time
  await page.click(`[data-guess="${q.real === correct ? 'real' : 'fake'}"]`);
  await expect(page.locator('.feedback')).toBeVisible();
}

async function playToGameOver(page) {
  await page.goto('/play?mode=normal');
  await expect(page.locator('#game .name')).not.toHaveText('Loading…');
  await answer(page, true);
  await expect(page.locator('.score-val')).toHaveText('1');
  for (let i = 0; i < 3; i++) {
    await page.click('.next');
    await expect(page.locator('.feedback')).toBeHidden();
    await answer(page, false);
  }
  await expect(page.locator('.next')).toHaveText('See result');
  await page.click('.next');
  // Game over goes straight to the result page.
  await expect(page).toHaveURL(/\/r\/[A-Za-z0-9_-]{8}$/);
}

test('double-clicking Next does not trigger the error screen', async ({ page }) => {
  await page.goto('/play?mode=normal');
  await expect(page.locator('#game .name')).not.toHaveText('Loading…');
  await answer(page, true);
  await expect(page.locator('.feedback')).toBeVisible();
  await page.dblclick('.next');
  await expect(page.locator('.error')).toBeHidden();
  // After a double-click, the next question should appear (busy guard prevented duplicate requests)
  await expect(page.locator('.feedback')).toBeHidden();
});

test('normal run to game over produces a shareable result page', async ({ page }) => {
  await playToGameOver(page);
  const og = await page.locator('meta[property="og:image"]').getAttribute('content');
  expect(og).toMatch(/\/og\/[A-Za-z0-9_-]{8}\.png$/);
  const image = await page.request.get(og);
  expect(image.headers()['content-type']).toBe('image/png');
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary_large_image');
});

test('hard mode timeout costs a strike', async ({ page }) => {
  await page.goto('/play?mode=hard');
  await expect(page.locator('.timer')).toBeVisible();
  await expect(page.locator('.verdict')).toContainText("Time's up", { timeout: 10_000 });
  await expect(page.locator('.strikes')).toHaveText('✖○○');
});

test('copy image falls back to a download without ClipboardItem', async ({ page }) => {
  await page.addInitScript(() => { delete window.ClipboardItem; });
  await playToGameOver(page);
  const download = page.waitForEvent('download');
  await page.click('text=Copy image');
  expect((await download).suggestedFilename()).toBe('aws-or-not.png');
});

test('server 500 on /answer triggers recovery via /next, no error screen shown', async ({ page }) => {
  await page.goto('/play?mode=normal');
  await expect(page.locator('#game .name')).not.toHaveText('Loading…');

  // Answer the first question correctly so we have an active run
  await answer(page, true);
  await expect(page.locator('.feedback')).toBeVisible();
  await page.click('.next');
  await expect(page.locator('.feedback')).toBeHidden();

  // Intercept the next POST /api/runs/.../answer and return 500 without forwarding
  let intercepted = false;
  await page.route('**/api/runs/*/answer', async (route) => {
    if (!intercepted) {
      intercepted = true;
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    } else {
      await route.continue();
    }
  });

  // Answer; the fake 500 triggers the client to call /next for the pending question
  await page.waitForTimeout(450);
  await page.click('[data-guess="real"]');

  // The client should recover: question choices are shown again, no error screen
  await expect(page.locator('.error')).toBeHidden();
  await expect(page.locator('.choices')).toBeVisible({ timeout: 3000 });
});

test('Next appears where the choices were, and promotion does not move the buttons', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 });
  await page.goto('/play?mode=normal');
  await expect(page.locator('#game .name')).not.toHaveText('Loading…');
  const choicesTop = (await page.locator('[data-guess="real"]').boundingBox()).y;
  for (let i = 0; i < 4; i++) {
    await answer(page, true);
    const nextBox = await page.locator('.next').boundingBox();
    expect(Math.abs(nextBox.y - choicesTop)).toBeLessThan(2);
    await page.click('.next');
    await expect(page.locator('.feedback')).toBeHidden();
  }
  // Question 5 is the first tier-2 question: the badge shows, the buttons stay put.
  await expect(page.locator('.promo')).toBeVisible();
  expect(Math.abs((await page.locator('[data-guess="real"]').boundingBox()).y - choicesTop)).toBeLessThan(2);
  const hud = await page.locator('.hud').boundingBox();
  const rank = await page.locator('.hud .rank-now').boundingBox();
  expect(rank.height).toBeLessThan(hud.height + 1); // single line, no wrap
});
