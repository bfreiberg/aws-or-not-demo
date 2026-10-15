import { Hono } from 'hono';
import { renderCard } from '../shared/card.js';
import { makeOriginOf } from '../shared/http.js';
import { RESULT_ID } from './api.js';
import { homePage, leaderboardPage, playPage, resultPage } from './views.js';

const OG_FILE = /^([A-Za-z0-9_-]{8})\.png$/;

export function pageRoutes({ store, assetDir, publicOrigin }) {
  const originOf = makeOriginOf(publicOrigin);
  const boards = async (limit) => {
    const [normal, hard] = await Promise.all([store.getLeaderboard('normal', limit), store.getLeaderboard('hard', limit)]);
    return { normal, hard };
  };
  const pages = new Hono();

  pages.get('/', async (c) => c.html(homePage({ boards: await boards(10) })));
  pages.get('/leaderboard', async (c) => c.html(leaderboardPage({ boards: await boards(50) })));
  pages.get('/play', (c) => c.html(playPage(c.req.query('mode') === 'hard' ? 'hard' : 'normal')));

  pages.get('/r/:id', async (c) => {
    const id = c.req.param('id');
    const result = RESULT_ID.test(id) ? await store.getResult(id) : null;
    if (!result) return c.notFound();
    return c.html(resultPage({ result, origin: originOf(c) }));
  });

  // /og/<id>.png: share card with the call to action (link previews, Copy image).
  // /card/<id>.png: same card without it, for the result page, which has a real Play link.
  const cardRoute = (cta) => async (c) => {
    const match = OG_FILE.exec(c.req.param('file'));
    const result = match ? await store.getResult(match[1]) : null;
    if (!result) return c.notFound();
    const png = await renderCard(result, { assetDir, siteHost: new URL(originOf(c)).host, cta });
    return c.body(png, 200, {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=31536000, immutable',
    });
  };
  pages.get('/og/:file', cardRoute(true));
  pages.get('/card/:file', cardRoute(false));

  return pages;
}
