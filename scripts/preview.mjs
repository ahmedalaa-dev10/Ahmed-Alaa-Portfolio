import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT || 4173);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2', '.pdf': 'application/pdf' };
const publicFiles = new Set(['index.html', 'owner-app.html', 'favicon.svg', 'manifest.webmanifest', 'owner.webmanifest', 'sw.js', 'offline.html']);
createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      response.writeHead(403).end();
      return;
    }
    const isAsset = relative.split(path.sep)[0] === 'assets' && relative !== 'assets';
    if (!publicFiles.has(relative) && !isAsset) {
      response.writeHead(404).end();
      return;
    }
    const data = await readFile(file);
    response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    response.end(data);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, '127.0.0.1', () => console.log(`Portfolio preview: http://127.0.0.1:${port}`));
