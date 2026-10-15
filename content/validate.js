import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { questionId } from './ids.js';
import { MAX_TIER } from '../shared/engine.js';

const ID = /^[a-z0-9-]{3,64}$/;

export function validateQuestions(questions, { minPerSide = 10 } = {}) {
  const errors = [];
  const seen = new Set();
  for (const q of questions) {
    const label = q?.id ?? JSON.stringify(q);
    if (typeof q.id !== 'string' || !ID.test(q.id)) errors.push(`invalid id: ${label}`);
    else if (seen.has(q.id)) errors.push(`duplicate id: ${q.id}`);
    else seen.add(q.id);
    if (typeof q.id === 'string' && typeof q.name === 'string' && q.id !== questionId(q.name)) {
      errors.push(`id must equal questionId(name): ${q.id}`);
    }
    if (typeof q.name !== 'string' || q.name.trim() === '' || q.name.length > 60) errors.push(`invalid name: ${label}`);
    if (typeof q.real !== 'boolean') errors.push(`invalid real: ${label}`);
    if (!Number.isInteger(q.tier) || q.tier < 1 || q.tier > MAX_TIER) errors.push(`invalid tier: ${label}`);
    if (typeof q.explanation !== 'string' || q.explanation.trim() === '' || q.explanation.length > 200) {
      errors.push(`invalid explanation: ${label}`);
    }
  }
  for (let tier = 1; tier <= MAX_TIER; tier++) {
    for (const [side, real] of [['real', true], ['fake', false]]) {
      const count = questions.filter((q) => q.tier === tier && q.real === real).length;
      if (count < minPerSide) errors.push(`tier ${tier} has ${count} ${side} (need ${minPerSide})`);
    }
  }
  return errors;
}

// CLI: node content/validate.js <file> [minPerSide]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file = 'content/questions.json', min = '10'] = process.argv.slice(2);
  const errors = validateQuestions(JSON.parse(await readFile(file, 'utf8')), { minPerSide: Number(min) });
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log(`${file}: OK`);
}
