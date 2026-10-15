import { describe, it, expect } from 'vitest';
import { renderCard } from '../shared/card.js';

const assetDir = new URL('../game/assets/', import.meta.url);
const result = {
  id: 'abcd1234', handle: 'Serverless Otter #4821', mode: 'hard', score: 17, tier: 4,
  answers: [true, true, false, true, true, true, false, true, true, false], createdAt: 1,
};

describe('renderCard', () => {
  it('renders a 1200x630 PNG', async () => {
    const png = await renderCard(result, { assetDir, siteHost: 'example.com' });
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
  });

  it('renders cards with missed-question names, and legacy cards without them', async () => {
    for (const r of [
      { ...result, misses: ['AWS Lambda Lounge', 'Amazon Honeycode', 'A very long made-up service name that must be truncated'] },
      { ...result, misses: [{ name: 'Amazon Honeycode', real: true }, { name: 'AWS Lambda Lounge', real: false }, { name: 'Amazon S3', real: true, timedOut: true }] },
      { ...result, tier: 5, misses: [] },
    ]) {
      const png = await renderCard(r, { assetDir, siteHost: 'a-very-long-generated-endpoint-host.lambda-web.us-east-1.on.aws' });
      expect(png.readUInt32BE(16)).toBe(1200);
      expect(png.readUInt32BE(20)).toBe(630);
    }
  });

  it('can render repeatedly (wasm initialised once)', async () => {
    const [a, b] = await Promise.all([
      renderCard(result, { assetDir, siteHost: 'example.com' }),
      renderCard({ ...result, score: 0, answers: [] }, { assetDir, siteHost: 'example.com' }),
    ]);
    expect(a.length).toBeGreaterThan(1000);
    expect(b.length).toBeGreaterThan(1000);
  });
});
