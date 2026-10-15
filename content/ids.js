import { createHash } from 'node:crypto';

// Derived from the name only, so an id never reveals whether a question is real or fake.
export const questionId = (name) => createHash('sha256').update(name.trim()).digest('hex').slice(0, 12);
