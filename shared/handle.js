const ADJECTIVES = [
  'Serverless', 'Elastic', 'Provisioned', 'Durable', 'Ephemeral', 'Stateless', 'Idempotent', 'Burstable',
  'Spot', 'Graviton', 'Async', 'Eventual', 'Regional', 'Global', 'Immutable', 'Cached',
];
const ANIMALS = [
  'Otter', 'Falcon', 'Lynx', 'Narwhal', 'Badger', 'Heron', 'Gecko', 'Panda',
  'Koala', 'Orca', 'Puffin', 'Yak', 'Ibex', 'Marmot', 'Quokka', 'Tapir',
];

export function generateHandle(rng = Math.random) {
  const pick = (list) => list[Math.floor(rng() * list.length)];
  const number = 1000 + Math.floor(rng() * 9000);
  return `${pick(ADJECTIVES)} ${pick(ANIMALS)} #${number}`;
}
