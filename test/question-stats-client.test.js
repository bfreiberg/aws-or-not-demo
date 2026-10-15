import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadQuestionStats } from '../game/public/question-stats.js';

afterEach(() => { vi.unstubAllGlobals(); });
const response = (pctCorrect) => ({ ok: true, json: async () => ({ pctCorrect }) });

describe('optional statistics feedback', () => {
  it('shows the percentage when the answered question is still visible', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(75)));
    const element = { hidden: true, textContent: '' };
    await loadQuestionStats('q1', element, () => true);
    expect(element).toEqual({ hidden: false, textContent: '75% of players got this right.' });
  });

  it('does not overwrite feedback after the player moves to another question', async () => {
    let resolve;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((r) => { resolve = r; })));
    const element = { hidden: true, textContent: '' };
    let current = true;
    const loading = loadQuestionStats('q1', element, () => current);
    current = false;
    resolve(response(75));
    await loading;
    expect(element).toEqual({ hidden: true, textContent: '' });
  });

  it.each([null, undefined, '75', -1, 101])('keeps missing or invalid statistics hidden: %s', async (value) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(value)));
    const element = { hidden: true, textContent: '' };
    await loadQuestionStats('q1', element, () => true);
    expect(element.hidden).toBe(true);
  });

  it('ignores a failed statistics request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Offline')));
    const element = { hidden: true, textContent: '' };
    await expect(loadQuestionStats('q1', element, () => true)).resolves.toBeUndefined();
    expect(element.hidden).toBe(true);
  });

  it('ignores an HTTP failure without reading its body', async () => {
    const json = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json }));
    const element = { hidden: true, textContent: '' };
    await loadQuestionStats('q1', element, () => true);
    expect(json).not.toHaveBeenCalled();
    expect(element.hidden).toBe(true);
  });
});
