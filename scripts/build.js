import { build } from 'esbuild';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { copyAssets } from './assets.js';

// FUNCTIONS=game builds one function (used before admin exists).
const FUNCTIONS = process.env.FUNCTIONS?.split(',') ?? ['game', 'admin'];

async function hashDir(dir) {
  const hash = createHash('sha256');
  const walk = async (d) => {
    for (const entry of (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) await walk(path);
      else hash.update(path.slice(dir.length)).update(await readFile(path));
    }
  };
  await walk(dir);
  return hash.digest('hex').slice(0, 16);
}

const { source, count } = await copyAssets();
console.log(`build: ${count} questions from content/${source}`);

await Promise.all([
  rm('dist/game', { recursive: true, force: true }),
  rm('dist/admin', { recursive: true, force: true }),
  rm('dist/game.zip', { force: true }),
  rm('dist/admin.zip', { force: true }),
  rm('dist/manifest.json', { force: true }),
]);
const manifest = {};
for (const fn of FUNCTIONS) {
  const out = `dist/${fn}`;
  await mkdir(out, { recursive: true });
  await build({
    entryPoints: [`${fn}/index.js`],
    outfile: `${out}/index.js`,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    legalComments: 'none',
    // Some bundled CommonJS dependencies call require(); give ESM output a real one.
    // Use an aliased import to avoid colliding with fflate's own `import { createRequire }`.
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  });
  await cp(`${fn}/public`, `${out}/public`, { recursive: true });
  await cp(`${fn}/assets`, `${out}/assets`, { recursive: true });
  await writeFile(`${out}/package.json`, JSON.stringify({ name: `aws-or-not-${fn}`, type: 'module' }));
  const key = `${fn}/${await hashDir(out)}.zip`;
  execFileSync('zip', ['-qrX', `../${fn}.zip`, '.'], { cwd: out });
  manifest[fn] = { file: `dist/${fn}.zip`, key };
}
await writeFile('dist/manifest.json', JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
