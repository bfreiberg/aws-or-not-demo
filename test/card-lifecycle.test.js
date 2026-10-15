import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderCard } from '../shared/card.js';

const { render, asPng, freeImage, freeRenderer } = vi.hoisted(() => ({
  render: vi.fn(),
  asPng: vi.fn(),
  freeImage: vi.fn(),
  freeRenderer: vi.fn(),
}));

vi.mock('satori', () => ({ default: async () => '<svg />' }));
vi.mock('@resvg/resvg-wasm', () => ({
  initWasm: async () => {},
  Resvg: class {
    render = render;
    free = freeRenderer;
  },
}));

const result = { handle: 'Spot Yak #4242', mode: 'normal', score: 1, tier: 1, answers: [true] };
const options = { assetDir: new URL('../game/assets/', import.meta.url), siteHost: 'example.com' };

beforeEach(() => {
  for (const mock of [render, asPng, freeImage, freeRenderer]) mock.mockReset();
  render.mockReturnValue({ asPng, free: freeImage });
});

describe('card renderer allocation lifecycle', () => {
  it('returns an independent PNG buffer and releases both allocations', async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    asPng.mockReturnValue(bytes);
    freeImage.mockImplementation(() => bytes.fill(0));

    const png = await renderCard(result, options);

    expect(png).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(freeImage).toHaveBeenCalledTimes(1);
    expect(freeRenderer).toHaveBeenCalledTimes(1);
    expect(freeImage.mock.invocationCallOrder[0]).toBeLessThan(freeRenderer.mock.invocationCallOrder[0]);
  });

  it('releases the renderer when rendering throws', async () => {
    const error = new Error('render failed');
    render.mockImplementation(() => { throw error; });

    await expect(renderCard(result, options)).rejects.toBe(error);

    expect(freeRenderer).toHaveBeenCalledTimes(1);
    expect(freeImage).not.toHaveBeenCalled();
  });

  it('releases both allocations when PNG encoding throws', async () => {
    const error = new Error('encoding failed');
    asPng.mockImplementation(() => { throw error; });

    await expect(renderCard(result, options)).rejects.toBe(error);

    expect(freeImage).toHaveBeenCalledTimes(1);
    expect(freeRenderer).toHaveBeenCalledTimes(1);
  });

  it('still releases the renderer if image cleanup throws', async () => {
    const error = new Error('image cleanup failed');
    asPng.mockReturnValue(new Uint8Array());
    freeImage.mockImplementation(() => { throw error; });

    await expect(renderCard(result, options)).rejects.toBe(error);

    expect(freeImage).toHaveBeenCalledTimes(1);
    expect(freeRenderer).toHaveBeenCalledTimes(1);
  });
});
