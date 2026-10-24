// Tiny static server for the E1 probe plus POST /log (writes results/*.json on the laptop). Local only.
// Usage: node server.mjs [port]   then: adb reverse tcp:PORT tcp:PORT, open http://localhost:PORT/?auto=1 on the phone.
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('./dist', import.meta.url)));
const resultsDir = resolve(fileURLToPath(new URL('./results', import.meta.url)));
const port = Number(process.argv[2] ?? 8099);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.png': 'image/png', '.tflite': 'application/octet-stream', '.json': 'application/json', '.css': 'text/css' };

createServer((req, res) => {
  console.log(new Date().toISOString(), req.method, req.url, 'origin=' + (req.headers.origin ?? '-'));
  // Cross-origin isolation so the threaded WASM trial can use SharedArrayBuffer.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cache-Control', 'no-store');
  // The Capacitor WebView page (https://localhost) posts its report here through `adb reverse`; allow only that origin.
  res.setHeader('Access-Control-Allow-Origin', 'https://localhost');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return void res.writeHead(204).end();
  if (req.method === 'POST' && req.url === '/log') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      mkdirSync(resultsDir, { recursive: true });
      const name = `e1-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      writeFileSync(join(resultsDir, name), Buffer.concat(chunks));
      console.log('saved', name);
      res.writeHead(204).end();
    });
    return;
  }
  const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^([/\\])+/, '');
  const file = resolve(root, path === '' ? 'index.html' : path);
  if (!file.startsWith(root)) return void res.writeHead(403).end();
  try {
    if (!statSync(file).isFile()) throw new Error('not a file');
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`E1 server on http://127.0.0.1:${port}`));
