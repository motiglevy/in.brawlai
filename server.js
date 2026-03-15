const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const BRAWL_TOKEN = process.env.BRAWL_TOKEN || process.env.BS_TOKEN || '';

// Token is optional for local use — API endpoints will return a clear error without it
if (!BRAWL_TOKEN) {
  console.warn('\n  ⚠️  No API token set. Player lookup and rotation will use fallback data.');
  console.warn('  To enable live data: BRAWL_TOKEN=your_key node server.js\n');
} else {
  console.log(`\n  ✅ API key loaded (${BRAWL_TOKEN.slice(0, 8)}...)`);
}

function normalizeTag(raw) {
  let tag = decodeURIComponent(raw).trim().toUpperCase().replace(/\s/g, '');
  if (!tag.startsWith('#')) tag = '#' + tag;
  return tag;
}

function brawlApiFetch(apiPath) {
  if (!BRAWL_TOKEN) return Promise.reject(new Error('No API token configured'));
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.brawlstars.com',
      path: apiPath,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${BRAWL_TOKEN}`,
        'Accept': 'application/json',
      },
    };
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, status, data) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function handlePlayer(res, rawTag) {
  if (!BRAWL_TOKEN) return json(res, 503, { error: 'No API token — set BRAWL_TOKEN to enable player lookup.' });
  const tag = normalizeTag(rawTag);
  if (!/^#[0-9A-Z]{5,12}$/.test(tag)) return json(res, 400, { error: 'Invalid player tag format.' });
  try {
    const result = await brawlApiFetch(`/v1/players/${encodeURIComponent(tag)}`);
    cors(res);
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(result.body);
  } catch (err) {
    json(res, 502, { error: 'Failed to reach Brawl Stars API.', detail: err.message });
  }
}

async function handleEvents(res) {
  if (!BRAWL_TOKEN) return json(res, 503, { error: 'No API token — set BRAWL_TOKEN to enable live rotation.' });
  try {
    const result = await brawlApiFetch('/v1/events/rotation');
    cors(res);
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(result.body);
  } catch (err) {
    json(res, 502, { error: 'Failed to reach Brawl Stars API.', detail: err.message });
  }
}

function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html', '.js': 'application/javascript',
    '.css': 'text/css', '.json': 'application/json',
    '.png': 'image/png', '.svg': 'image/svg+xml'
  };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    cors(res);
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  const playerMatch = url.pathname.match(/^\/api\/player\/(.+)$/);
  if (playerMatch && req.method === 'GET') return handlePlayer(res, playerMatch[1]);
  if (url.pathname === '/api/events' && req.method === 'GET') return handleEvents(res);

  // Serve frontend
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return serveStatic(res, path.join(__dirname, 'index.html'));
  }
  const safePath = path.join(__dirname, url.pathname);
  if (safePath.startsWith(__dirname)) return serveStatic(res, safePath);
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n  🎮 Brawl Coach → http://localhost:${PORT}\n`);
  console.log(`  GET /                  → App`);
  console.log(`  GET /api/player/:tag   → Player lookup`);
  console.log(`  GET /api/events        → Event rotation`);
  if (!BRAWL_TOKEN) {
    console.log(`\n  ℹ️  Running without API token.`);
    console.log(`  Open http://localhost:${PORT} — cached/guest data will be used.\n`);
  } else {
    console.log('');
  }
});
