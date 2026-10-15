import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { validateQuestions } from '../content/validate.js';
import { normalize, nameDistance, tooSimilar } from '../content/similarity.js';
import { questions } from './fixtures/questions.js';
import { questionId } from '../content/ids.js';

// Opaque copy of the test fixture: ids derived from names, never revealing real/fake.
const opaque = questions.map((q) => ({ ...q, id: questionId(q.name) }));

describe('validateQuestions', () => {
  it('accepts a balanced set', () => {
    expect(validateQuestions(opaque, { minPerSide: 3 })).toEqual([]);
  });

  it('reports duplicate ids', () => {
    // Two questions with the same name produce the same opaque id.
    const errors = validateQuestions([...opaque, { ...opaque[0] }], { minPerSide: 3 });
    expect(errors).toContain(`duplicate id: ${questionId(opaque[0].name)}`);
  });

  it('reports invalid fields', () => {
    const bad = [{ id: 'X Y', name: '', real: 'yes', tier: 7, explanation: '' }];
    const errors = validateQuestions(bad, { minPerSide: 0 });
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('invalid id'),
      expect.stringContaining('invalid name'),
      expect.stringContaining('invalid real'),
      expect.stringContaining('invalid tier'),
      expect.stringContaining('invalid explanation'),
    ]));
  });

  it('reports tiers below the minimum per side', () => {
    const errors = validateQuestions(opaque, { minPerSide: 4 });
    expect(errors).toContain('tier 1 has 3 real (need 4)');
    expect(errors).toContain('tier 1 has 3 fake (need 4)');
  });

  it('reports id that does not equal questionId(name)', () => {
    const bad = { ...opaque[0], id: 'r-1-s3abc' };
    const errors = validateQuestions([bad, ...opaque.slice(1)], { minPerSide: 3 });
    expect(errors).toContain(`id must equal questionId(name): r-1-s3abc`);
  });

  it('accepts the committed sample with minPerSide 2', async () => {
    const sample = JSON.parse(await readFile(new URL('../content/questions.sample.json', import.meta.url), 'utf8'));
    expect(validateQuestions(sample, { minPerSide: 2 })).toEqual([]);
  });

  it('sample ids equal questionId(name) and none start with r- or f-', async () => {
    const sample = JSON.parse(await readFile(new URL('../content/questions.sample.json', import.meta.url), 'utf8'));
    for (const q of sample) {
      expect(q.id).toBe(questionId(q.name));
      expect(q.id).not.toMatch(/^[rf]-/);
    }
  });
});

describe('similarity', () => {
  it('normalizes the Amazon/AWS prefix, case and punctuation', () => {
    expect(normalize('Amazon Dynamo-DB')).toBe('dynamodb');
    expect(normalize('AWS Lambda')).toBe('lambda');
  });

  it('measures normalized distance', () => {
    expect(nameDistance('Amazon S3', 'AWS S3')).toBe(0);
    expect(nameDistance('AWS Lambada', 'AWS Lambda')).toBeCloseTo(1 / 7);
  });

  it('flags near-duplicates of real names', () => {
    expect(tooSimilar('AWS Lambada', ['AWS Lambda'])).toBe(true);
    expect(tooSimilar('Amazon Elastic Banana', ['AWS Elastic Beanstalk'])).toBe(false);
  });
});
