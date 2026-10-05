import { build } from 'vite';
import { readFile, writeFile, readdir, mkdir, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = path.join(root, '.build');
const renderDirectory = path.join(root, '.render');
const configFile = path.join(root, 'vite.config.ts');

await build({ configFile });
await build({
  configFile,
  build: {
    ssr: path.join(root, 'source/render.tsx'),
    outDir: renderDirectory,
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'render.js' } },
  },
});

const { render } = await import(pathToFileURL(path.join(renderDirectory, 'render.js')).href);
const template = await readFile(path.join(temporary, 'index.html'), 'utf8');
if (!template.includes('<!--portfolio-->')) throw new Error('Missing portfolio render marker.');
const html = template.replace('<!--portfolio-->', render());

async function copyOutput(directory, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'index.html') continue;
    const source = path.join(directory, entry.name);
    const target = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyOutput(source, target);
    else await copyFile(source, target);
  }
}
await copyOutput(temporary, root);
await writeFile(path.join(root, 'index.html'), html);
await writeFile(path.join(root, '.nojekyll'), '');
await rm(temporary, { recursive: true });
await rm(renderDirectory, { recursive: true });
console.log('GitHub Pages build is ready. Upload index.html, assets/ and the root PWA files together.');
