export const RANKS = Object.freeze([
  'Solutions Architect Intern',
  'Associate Solutions Architect',
  'Solutions Architect',
  'Senior Solutions Architect',
  'Principal Solutions Architect',
  'Senior Principal Solutions Architect',
]);

export function rankForTier(tier) {
  const index = Math.min(Math.max(tier, 1), RANKS.length) - 1;
  return RANKS[index];
}
