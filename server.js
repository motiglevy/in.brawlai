const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const BRAWL_TOKEN = process.env.BRAWL_TOKEN || process.env.BS_TOKEN || '';

if (!BRAWL_TOKEN) {
  console.warn('\n  ⚠️  No BRAWL_TOKEN set. Player lookup will return 503.');
  console.warn('  Add it in Render: Dashboard → Your Service → Environment → Add Variable');
  console.warn('  Variable name: BRAWL_TOKEN   Value: <your Brawl Stars API key>\n');
} else {
  console.log('  ✅  API token loaded.\n');
}

function normalizeTag(raw) {
  let tag = decodeURIComponent(raw).trim().toUpperCase().replace(/\s/g, '');
  if (!tag.startsWith('#')) tag = '#' + tag;
  return tag;
}

function brawlApiFetch(apiPath) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.brawlstars.com',
      path: apiPath,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + BRAWL_TOKEN,
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
  if (!BRAWL_TOKEN) {
    return json(res, 503, { error: 'Server has no API token configured. Add BRAWL_TOKEN in Render environment variables.' });
  }
  const tag = normalizeTag(rawTag);
  if (!/^#[0-9A-Z]{3,12}$/.test(tag)) {
    return json(res, 400, { error: 'Invalid player tag format.' });
  }
  const encoded = encodeURIComponent(tag);
  try {
    const result = await brawlApiFetch('/v1/players/' + encoded);
    cors(res);
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(result.body);
  } catch (err) {
    json(res, 502, { error: 'Failed to reach Brawl Stars API.', detail: err.message });
  }
}

async function handleEvents(res) {
  if (!BRAWL_TOKEN) {
    return json(res, 503, { error: 'Server has no API token configured. Add BRAWL_TOKEN in Render environment variables.' });
  }
  try {
    const result = await brawlApiFetch('/v1/events/rotation');
    cors(res);
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(result.body);
  } catch (err) {
    json(res, 502, { error: 'Failed to reach Brawl Stars API.', detail: err.message });
  }
}

async function handleBrawlers(res) {
  if (!BRAWL_TOKEN) {
    return json(res, 503, { error: 'Server has no API token configured. Add BRAWL_TOKEN in Render environment variables.' });
  }
  try {
    const result = await brawlApiFetch('/v1/brawlers');
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
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
  };
  const contentType = types[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found: ' + filePath);
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  const playerMatch = url.pathname.match(/^\/api\/player\/(.+)$/);
  if (playerMatch && req.method === 'GET') return handlePlayer(res, playerMatch[1]);
  if (url.pathname === '/api/events' && req.method === 'GET') return handleEvents(res);
  if (url.pathname === '/api/brawlers' && req.method === 'GET') return handleBrawlers(res);

  // Serve the frontend — matches both "/" and "/index.html" and "/Index.html"
  if (url.pathname === '/' || url.pathname.toLowerCase() === '/index.html') {
    // Try Index.html first (repo filename), then brawl-coach.html as fallback
    const indexPath = path.join(__dirname, 'Index.html');
    const fallbackPath = path.join(__dirname, 'brawl-coach.html');
    if (fs.existsSync(indexPath)) return serveStatic(res, indexPath);
    return serveStatic(res, fallbackPath);
  }

  const safePath = path.join(__dirname, url.pathname);
  if (safePath.startsWith(__dirname)) return serveStatic(res, safePath);
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('\n  inB | Brawl Coach server running at http://localhost:' + PORT);
  console.log('  Endpoints:');
  console.log('    GET /                   → Frontend (Index.html)');
  console.log('    GET /api/player/:tag    → Player lookup');
  console.log('    GET /api/events         → Event rotation');
  console.log('    GET /api/brawlers       → All brawlers\n');
});
