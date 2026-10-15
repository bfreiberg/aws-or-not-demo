import { MAX_TIER } from '../shared/engine.js';

const TIER_STYLE = {
  1: 'obviously fake, funny names anyone spots instantly (puns, food, animals, absurd ideas)',
  2: 'silly but vaguely plausible names that someone new to AWS might hesitate on',
  3: 'plausible names that follow AWS naming conventions and describe believable products',
  4: 'convincing names that a regular AWS user might believe are real',
  5: 'very convincing names that an experienced AWS user might believe are real',
  6: 'extremely convincing names that mimic obscure, niche or industry-specific AWS services, using the exact "Amazon"/"AWS" prefix conventions',
};

export function buildPrompt({ tier, examples, count }) {
  return `You are writing content for a quiz called "AWS or Not?", where players guess whether a name is a real AWS service.

Difficulty tier ${tier} of ${MAX_TIER}. Generate exactly ${count} FAKE service names that are ${TIER_STYLE[tier]}.

Real services at this tier, for style only (do not reuse or lightly modify them):
${examples.map((e) => `- ${e.name}`).join('\n')}

Rules:
- Names start with "Amazon " or "AWS ". At most one name in this batch may instead copy a real unprefixed pattern, such as "EC2 <capability>" (like "EC2 Image Builder"), so the prefix alone never gives the answer away.
- Never use real third-party company or product names (e.g. no "Snowflake", "Splunk", "Citrix", "SAP").
- No name may be an existing, past or announced AWS service.
- Keep names under 40 characters.
- For each, write a one-sentence, friendly "explanation" shown after the player answers, starting with "Made up." and optionally naming the real service it resembles.

Respond with only a JSON array of {"name": string, "explanation": string} objects.`;
}

export function parseJsonArray(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) throw new Error('No JSON array in model output');
  return JSON.parse(text.slice(start, end + 1));
}

export const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
