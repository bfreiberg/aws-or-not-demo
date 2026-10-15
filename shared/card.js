import satori from 'satori';
import { Resvg, initWasm } from '@resvg/resvg-wasm';
import { readFile } from 'node:fs/promises';
import { rankForTier } from './ranks.js';

const COLORS = { bg: '#161E2D', panel: '#232F3E', accent: '#FF9900', text: '#FFFFFF', muted: '#AAB7B8', good: '#1D8102', bad: '#D13212' };

// Write-once init promise: the WASM module and fonts load once per execution environment.
let ready;
export function initCard(assetDir) {
  ready ??= (async () => {
    const [wasm, regular, bold] = await Promise.all([
      readFile(new URL('resvg.wasm', assetDir)),
      readFile(new URL('inter-400.woff', assetDir)),
      readFile(new URL('inter-700.woff', assetDir)),
    ]);
    await initWasm(wasm);
    return [
      { name: 'Inter', data: regular, weight: 400, style: 'normal' },
      { name: 'Inter', data: bold, weight: 700, style: 'normal' },
    ];
  })();
  return ready;
}

const h = (type, style, children) => ({ type, props: { style, children } });

// A miss is { name, real, timedOut? }. The pill shows the truth: REAL (the player said made up)
// or FAKE (the player believed it). Results from before this change store plain names.
// Full-width row: pill + name on one line. Timeouts get a muted "· time's up" suffix.
const missRow = (miss) => {
  const { name, real, timedOut } = typeof miss === 'string' ? { name: miss } : miss;
  const pill = real === undefined
    ? { text: '\u00d7', bg: COLORS.bad, width: 40 }
    : real ? { text: 'REAL', bg: COLORS.good, width: 92 } : { text: 'FAKE', bg: COLORS.bad, width: 92 };
  return h('div', { display: 'flex', alignItems: 'center', marginTop: 12 }, [
    h('div', {
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      width: pill.width, height: 40, borderRadius: 10, marginRight: 20, backgroundColor: pill.bg,
      fontSize: real === undefined ? 30 : 20, fontWeight: 700, letterSpacing: real === undefined ? 0 : 2,
    }, pill.text),
    h('div', { fontSize: 32, fontWeight: 700, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', maxWidth: timedOut ? 800 : 960 }, name),
    ...(timedOut ? [h('div', { fontSize: 24, color: COLORS.muted, marginLeft: 14, flexShrink: 0 }, "· time's up")] : []),
  ]);
};

const dotRow = (answers) =>
  h('div', { display: 'flex' }, answers.slice(-10).map((ok) =>
    h('div', { width: 36, height: 36, borderRadius: 8, marginRight: 10, backgroundColor: ok ? COLORS.good : COLORS.bad })));

// cta: false renders the card for the result page, where the page itself carries a clickable Play button.
export async function renderCard(result, { assetDir, siteHost, cta = true }) {
  const fonts = await initCard(assetDir);
  const rank = rankForTier(result.tier);
  // Results saved before misses were recorded fall back to the answer dots.
  const misses = result.misses?.length
    ? h('div', { display: 'flex', flexDirection: 'column' }, [
      h('div', { fontSize: 24, color: COLORS.muted, letterSpacing: 3 }, 'TRIPPED UP BY'),
      ...result.misses.slice(-3).map(missRow),
    ])
    : dotRow(result.answers);

  // Layout: top row, then score + rank, then the misses at full width (so long names fit),
  // then the optional CTA band. With the band, the bottom padding shrinks to leave air above it.
  const tree = h('div', {
    width: 1200, height: 630, display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
    padding: cta ? '56px 64px 40px' : 64, boxSizing: 'border-box', backgroundColor: COLORS.bg, color: COLORS.text, fontFamily: 'Inter',
  }, [
    h('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, [
      // Same wordmark as the site header: "AWS or" in white, "Not?" in orange.
      h('div', { display: 'flex', fontSize: 48, fontWeight: 700 }, [
        h('div', { color: COLORS.text, marginRight: 13 }, 'AWS or'),
        h('div', { color: COLORS.accent }, 'Not?'),
      ]),
      h('div', { display: 'flex', alignItems: 'center' }, [
        h('div', { fontSize: 26, color: COLORS.muted, marginRight: 24 }, result.handle),
        h('div', { fontSize: 26, fontWeight: 700, padding: '8px 22px', borderRadius: 999, border: `3px solid ${COLORS.accent}`, color: COLORS.accent },
          result.mode === 'hard' ? 'HARD MODE' : 'NORMAL MODE'),
      ]),
    ]),
    // Grows to fill the space between the top row and the (optional) CTA band, content centered.
    h('div', { display: 'flex', flexGrow: 1, flexDirection: 'column', justifyContent: 'center', paddingBottom: cta ? 24 : 0 }, [
      h('div', { display: 'flex', alignItems: 'flex-end' }, [
        h('div', { fontSize: cta ? 124 : 170, fontWeight: 700, lineHeight: 1 }, String(result.score)),
        h('div', { display: 'flex', flexDirection: 'column', marginLeft: 32, marginBottom: cta ? 8 : 14 }, [
          h('div', { fontSize: 26, color: COLORS.muted }, 'correct · reached'),
          h('div', { fontSize: 38, fontWeight: 700, color: COLORS.accent, whiteSpace: 'nowrap' }, rank),
        ]),
      ]),
      h('div', { display: 'flex', flexDirection: 'column', marginTop: cta ? 20 : 36 }, [misses]),
    ]),
    // Call to action: the shared card's job is to bring the viewer to the game.
    cta && h('div', {
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '18px 28px', borderRadius: 18,
      // Long generated endpoint hosts get a smaller font so the URL is never cut off.
      backgroundColor: COLORS.panel, fontSize: siteHost.length > 30 ? 23 : 30, whiteSpace: 'nowrap',
    }, [
      h('div', { fontWeight: 700, marginRight: 14 }, 'Think you can beat it?'),
      h('div', { color: COLORS.accent, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }, `Play at ${siteHost}`),
    ]),
  ].filter(Boolean));

  const svg = await satori(tree, { width: 1200, height: 630, fonts });
  const renderer = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } });
  try {
    const image = renderer.render();
    try {
      return Buffer.from(image.asPng());
    } finally {
      image.free();
    }
  } finally {
    renderer.free();
  }
}
