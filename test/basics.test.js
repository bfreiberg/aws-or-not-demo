import { describe, it, expect } from 'vitest';
import { RANKS, rankForTier } from '../shared/ranks.js';
import { generateHandle } from '../shared/handle.js';
import { roastFor } from '../shared/roasts.js';

describe('ranks', () => {
  it('maps tiers 1..6 to the six titles', () => {
    expect(RANKS).toEqual([
      'Solutions Architect Intern',
      'Associate Solutions Architect',
      'Solutions Architect',
      'Senior Solutions Architect',
      'Principal Solutions Architect',
      'Senior Principal Solutions Architect',
    ]);
    expect(rankForTier(1)).toBe('Solutions Architect Intern');
    expect(rankForTier(6)).toBe('Senior Principal Solutions Architect');
  });

  it('clamps out-of-range tiers', () => {
    expect(rankForTier(0)).toBe(RANKS[0]);
    expect(rankForTier(9)).toBe(RANKS[5]);
  });
});

describe('generateHandle', () => {
  it('is deterministic for a given rng', () => {
    expect(generateHandle(() => 0)).toBe('Serverless Otter #1000');
  });

  it('matches the handle format', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateHandle()).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ #\d{4}$/);
    }
  });
});

describe('roastFor', () => {
  it('picks the line for the highest band reached', () => {
    expect(roastFor(0)).toMatch(/Elastic Banana/);
    expect(roastFor(2)).toBe(roastFor(0));
    expect(roastFor(3)).not.toBe(roastFor(0));
    expect(roastFor(99)).toBe(roastFor(23));
  });
});
