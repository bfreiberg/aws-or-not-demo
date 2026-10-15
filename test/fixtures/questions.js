const make = (tier, real, i) => ({
  id: `${real ? 'r' : 'f'}-${tier}-${i}`,
  name: `${real ? 'Real' : 'Fake'} ${tier}.${i}`,
  real,
  tier,
  explanation: `Explanation ${tier}.${i}`,
});

// 3 real + 3 fake per tier, ordered real-0, fake-0, real-1, ...
export const questions = [1, 2, 3, 4, 5, 6].flatMap((tier) =>
  [0, 1, 2].flatMap((i) => [make(tier, true, i), make(tier, false, i)]),
);

export const byId = new Map(questions.map((q) => [q.id, q]));

// rng that returns the given values in a loop
export const seq = (...values) => {
  let i = 0;
  return () => values[i++ % values.length];
};
