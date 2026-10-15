// Usage: AWS_PROFILE=<profile> node content/generate.js
// Reads content/real.json, writes content/questions.draft.json for human review.
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { readFile, writeFile } from 'node:fs/promises';
import { buildPrompt, parseJsonArray } from './prompt.js';
import { questionId } from './ids.js';
import { MAX_TIER } from '../shared/engine.js';
import { tooSimilar } from './similarity.js';
import { validateQuestions } from './validate.js';

const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'global.anthropic.claude-sonnet-5-5';
// Ids are always derived from the name, so they never reveal real vs fake.
const real = JSON.parse(await readFile(new URL('./real.json', import.meta.url), 'utf8'))
  .map((q) => ({ ...q, id: questionId(q.name) }));
const realErrors = validateQuestions(real, { minPerSide: 0 });
if (realErrors.length) throw new Error(`real.json is invalid:\n${realErrors.join('\n')}`);

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
const taken = real.map((q) => q.name);
const fakes = [];

// One tier per request. A response without a parseable JSON array (refusal, truncation) is retried;
// after the last attempt the tier is skipped so the other tiers are not lost.
async function requestFakes({ tier, examples, count }, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await client.send(new ConverseCommand({
      modelId: MODEL_ID,
      messages: [{ role: 'user', content: [{ text: buildPrompt({ tier, examples, count }) }] }],
      inferenceConfig: { maxTokens: 12000, temperature: 1 },
    }));
    const text = res.output.message.content.map((block) => block.text ?? '').join('');
    try {
      return parseJsonArray(text);
    } catch (err) {
      console.warn(`tier ${tier}: attempt ${attempt} failed (${err.message}; stopReason=${res.stopReason}): ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
    }
  }
  console.warn(`tier ${tier}: giving up after ${attempts} attempts`);
  return [];
}

for (let tier = 1; tier <= MAX_TIER; tier++) {
  const examples = real.filter((q) => q.tier === tier);
  const count = Math.ceil(examples.length * 1.3); // over-generate; the similarity filter drops some
  const items = await requestFakes({ tier, examples, count });
  let kept = 0;
  for (const item of items) {
    if (typeof item?.name !== 'string' || typeof item?.explanation !== 'string') continue;
    const name = item.name.trim();
    if (tooSimilar(name, taken)) {
      console.warn(`tier ${tier}: dropped "${name}" (too close to an existing name)`);
      continue;
    }
    taken.push(name);
    fakes.push({ id: questionId(name), name, real: false, tier, explanation: item.explanation.trim() });
    kept++;
  }
  console.log(`tier ${tier}: ${examples.length} real, ${kept} fakes kept`);
}

const draft = [...real, ...fakes];
await writeFile(new URL('./questions.draft.json', import.meta.url), `${JSON.stringify(draft, null, 2)}\n`);
const errors = validateQuestions(draft);
console.log(errors.length ? `Draft written with issues:\n${errors.join('\n')}` : 'Draft written and valid.');
console.log('Review content/questions.draft.json, then save it as content/questions.json.');
