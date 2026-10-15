export function createClock(start = 1_760_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

export const counterId = (prefix, width) => {
  let i = 0;
  return () => `${prefix}${String(++i).padStart(width, '0')}`;
};
