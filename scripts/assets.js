import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateQuestions } from '../content/validate.js';

const root = new URL('../', import.meta.url);
const exists = (url) => access(url).then(() => true, () => false);

export async function copyAssets() {
  const full = new URL('content/questions.json', root);
  const useFull = await exists(full);
  const source = useFull ? full : new URL('content/questions.sample.json', root);
  const questions = JSON.parse(await readFile(source, 'utf8'));
  const errors = validateQuestions(questions, { minPerSide: useFull ? 10 : 2 });
  if (errors.length) throw new Error(`Invalid ${fileURLToPath(source)}:\n- ${errors.join('\n- ')}`);

  for (const fn of ['game', 'admin']) {
    const dir = new URL(`${fn}/assets/`, root);
    await mkdir(dir, { recursive: true });
    await writeFile(new URL('questions.json', dir), JSON.stringify(questions));
  }

  const gameAssets = new URL('game/assets/', root);
  const modules = new URL('node_modules/', root);
  await cp(new URL('@resvg/resvg-wasm/index_bg.wasm', modules), new URL('resvg.wasm', gameAssets));
  await cp(new URL('@fontsource/inter/files/inter-latin-400-normal.woff', modules), new URL('inter-400.woff', gameAssets));
  await cp(new URL('@fontsource/inter/files/inter-latin-700-normal.woff', modules), new URL('inter-700.woff', gameAssets));

  return { source: useFull ? 'questions.json' : 'questions.sample.json', count: questions.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { source, count } = await copyAssets();
  console.log(`assets: ${count} questions from content/${source}`);
}
