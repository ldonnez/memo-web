import { createServer } from 'http';
import { readFileSync, statSync } from 'fs';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const PORT = process.env.PORT || 8080;
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

createServer((req, res) => {
  let path = req.url.split('?')[0];
  if (path === '/') path = '/index.html';

  const filePath = join(ROOT, path);

  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = extname(filePath);
    const content = readFileSync(filePath);

    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(PORT, () => {
  console.log(`Dev server: http://localhost:${PORT}`);
});
