import { describe, it, expect } from 'vitest';
import { buildPrompt, parseJsonArray, slug } from '../content/prompt.js';

describe('generator helpers', () => {
  it('builds a tier-specific prompt with examples and a count', () => {
    const prompt = buildPrompt({ tier: 5, examples: [{ name: 'AWS Ground Station' }], count: 12 });
    expect(prompt).toContain('AWS Ground Station');
    expect(prompt).toContain('exactly 12');
    expect(prompt).toContain('very convincing');
  });

  it('extracts a JSON array from surrounding text', () => {
    expect(parseJsonArray('Here you go:\n[{"name":"A","explanation":"B"}]\nEnjoy')).toEqual([{ name: 'A', explanation: 'B' }]);
    expect(() => parseJsonArray('no json')).toThrow();
  });

  it('slugifies names', () => {
    expect(slug('Amazon Elastic Banana!')).toBe('amazon-elastic-banana');
  });
});
