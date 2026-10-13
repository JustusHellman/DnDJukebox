// Serves dist/ on http://localhost:8787 with CORS and range requests, for testing DnDocs locally
// (set VITE_JUKEBOX_URL=http://localhost:8787/ in DnDocs' .env.local).
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const types = { '.json': 'application/json', '.html': 'text/html; charset=utf-8', '.m4a': 'audio/mp4', '.md': 'text/markdown' };
const port = Number(process.env.PORT || 8787);

createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(root, url.endsWith('/') ? url + 'index.html' : url);
  if (!file.startsWith(root)) return res.writeHead(403).end();
  let st;
  try {
    st = statSync(file);
  } catch {
    return res.writeHead(404).end('Not found');
  }
  const headers = { 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes', 'Content-Type': types[path.extname(file)] || 'application/octet-stream' };
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : st.size - 1;
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Jukebox on http://localhost:${port}/`));
