import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('deploy config example', () => {
  it('lists every key the stacks need, with placeholder values only', () => {
    const example = JSON.parse(readFileSync(new URL('../deploy-config.example.json', import.meta.url), 'utf8'));
    expect(Object.keys(example).sort()).toEqual(['alertEmail', 'budgetUsd', 'domain', 'hostedZoneId', 'hostedZoneName']);
    expect(example.domain.endsWith(`.${example.hostedZoneName}`)).toBe(true);
    expect(example.domain).toMatch(/example\.com$/);
    expect(example.alertEmail).toMatch(/@example\.com$/);
  });
});
