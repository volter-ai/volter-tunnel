// The Volter brand's tokens and faces (company decision 0018), fetched at build into
// theme/brand/ (gitignored) with relative font URLs, so the docs never load the brand at runtime.
// A failed fetch fails the build.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRAND = 'https://brand.volter.ai';
const out = resolve(dirname(fileURLToPath(import.meta.url)), 'theme/brand');
const fetched = async (path) => {
  const r = await fetch(`${BRAND}${path}`, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`brand ${path}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};
const css = (await fetched('/tokens.css')).toString('utf8').replaceAll(`${BRAND}/fonts/`, './fonts/');
const faces = [...new Set([...css.matchAll(/\.\/fonts\/([A-Za-z0-9_.-]+\.woff2)/g)].map((m) => m[1]))];
await mkdir(resolve(out, 'fonts'), { recursive: true });
for (const face of faces) await writeFile(resolve(out, 'fonts', face), await fetched(`/fonts/${face}`));
await writeFile(resolve(out, 'fonts', 'LICENSES.txt'), await fetched('/fonts/LICENSES.txt'));
await writeFile(resolve(out, 'tokens.css'), css);
console.error(`brand tokens: docs/.vitepress/theme/brand/tokens.css and ${faces.length} faces`);
