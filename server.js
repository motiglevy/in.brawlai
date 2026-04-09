'use strict';

const http  = require('http');
const https = require('https');
const path  = require('path');
const fs    = require('fs');
const db    = require('./db');

const PORT          = process.env.PORT || 3000;
const BRAWL_TOKEN   = process.env.BRAWL_TOKEN;
const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

if (!BRAWL_TOKEN) {
  console.error('ERROR: BRAWL_TOKEN environment variable is required.');
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, status, data) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── Brawl Stars API handlers ──────────────────────────────────────────────────

async function handlePlayer(res, rawTag) {
  const tag = normalizeTag(rawTag);
  if (!/^#[0-9A-Z]{5,12}$/.test(tag)) {
    return json(res, 400, { error: 'Invalid player tag format.' });
  }
  const encoded = encodeURIComponent(tag);
  try {
    const result = await brawlApiFetch(`/v1/players/${encoded}`);
    cors(res);
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(result.body);
  } catch (err) {
    json(res, 502, { error: 'Failed to reach Brawl Stars API.', detail: err.message });
  }
}

async function handleBrawlers(res) {
  try {
    const result = await brawlApiFetch('/v1/brawlers');
    cors(res);
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(result.body);
  } catch (err) {
    json(res, 502, { error: 'Failed to reach Brawl Stars API.', detail: err.message });
  }
}

// ── Battle log sync (shared by poller + register) ─────────────────────────────

async function syncPlayerBattles(tag) {
  try {
    const encoded = encodeURIComponent(tag);
    const result  = await brawlApiFetch(`/v1/players/${encoded}/battlelog`);
    if (result.status !== 200) {
      console.warn(`[Poller] Battle log fetch failed for ${tag}: HTTP ${result.status}`);
      return 0;
    }
    const parsed = JSON.parse(result.body);
    const items  = parsed.items || [];
    const inserted = await db.saveBattles(tag, items);
    await db.markPolled(tag);
    return inserted;
  } catch (err) {
    console.error(`[Poller] Error syncing ${tag}:`, err.message);
    return 0;
  }
}

// ── POST /api/register/:tag ───────────────────────────────────────────────────
// Called by the frontend when a player logs in. Registers them for polling
// and does an immediate battle log sync.

async function handleRegister(res, rawTag) {
  const tag = normalizeTag(rawTag);
  if (!/^#[0-9A-Z]{5,12}$/.test(tag)) {
    return json(res, 400, { error: 'Invalid player tag format.' });
  }
  try {
    // Fetch the player profile to get their name
    const encoded      = encodeURIComponent(tag);
    const profileRes   = await brawlApiFetch(`/v1/players/${encoded}`);
    let playerName     = null;
    if (profileRes.status === 200) {
      try { playerName = JSON.parse(profileRes.body).name; } catch (_) {}
    }

    // Register in DB (upsert)
    await db.registerPlayer(tag, playerName);

    // Immediately sync their latest battles
    const inserted = await syncPlayerBattles(tag);

    json(res, 200, { ok: true, tag, inserted });
  } catch (err) {
    json(res, 500, { error: 'Registration failed.', detail: err.message });
  }
}

// ── GET /api/battlelog/:tag ───────────────────────────────────────────────────
// Returns all stored battles for a player from our DB.

async function handleBattleLog(res, rawTag) {
  const tag = normalizeTag(rawTag);
  if (!/^#[0-9A-Z]{5,12}$/.test(tag)) {
    return json(res, 400, { error: 'Invalid player tag format.' });
  }
  try {
    const battles = await db.getBattles(tag, 500);
    json(res, 200, { tag, count: battles.length, battles });
  } catch (err) {
    json(res, 500, { error: 'Failed to fetch battle log.', detail: err.message });
  }
}

// ── Static file server ────────────────────────────────────────────────────────

function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
    '.png':  'image/png',
    '.svg':  'image/svg+xml',
  };
  const contentType = types[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// ── Router ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  // Existing endpoints
  const playerMatch = url.pathname.match(/^\/api\/player\/(.+)$/);
  if (playerMatch && req.method === 'GET') return handlePlayer(res, playerMatch[1]);

  if (url.pathname === '/api/brawlers' && req.method === 'GET') return handleBrawlers(res);

  // New battle log endpoints
  const registerMatch   = url.pathname.match(/^\/api\/register\/(.+)$/);
  if (registerMatch && req.method === 'POST') return handleRegister(res, registerMatch[1]);

  const battlelogMatch  = url.pathname.match(/^\/api\/battlelog\/(.+)$/);
  if (battlelogMatch && req.method === 'GET') return handleBattleLog(res, battlelogMatch[1]);

  // Static files
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return serveStatic(res, path.join(__dirname, 'index.html'));
  }

  const safePath = path.join(__dirname, url.pathname);
  if (safePath.startsWith(__dirname)) return serveStatic(res, safePath);

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ── Background poller ─────────────────────────────────────────────────────────

async function runPoller() {
  console.log('[Poller] Starting poll cycle…');
  try {
    const players = await db.getRegisteredPlayers();
    console.log(`[Poller] ${players.length} registered player(s).`);
    for (const tag of players) {
      const inserted = await syncPlayerBattles(tag);
      if (inserted > 0) console.log(`[Poller] ${tag}: +${inserted} new battle(s).`);
    }
  } catch (err) {
    console.error('[Poller] Cycle error:', err.message);
  }
  console.log('[Poller] Poll cycle complete.');
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function start() {
  // Try to initialise DB schema — non-fatal if DB is temporarily unreachable.
  // Player lookups will still work; battle log features degrade gracefully.
  let dbReady = false;
  try {
    await db.initSchema();
    dbReady = true;
  } catch (err) {
    console.error('[DB] Schema init failed — battle log unavailable until DB recovers:', err.message);
  }

  server.listen(PORT, () => {
    console.log(`\n  inB server running at http://localhost:${PORT}`);
    console.log(`  API key loaded (${BRAWL_TOKEN.slice(0, 8)}...)`);
    console.log(`  DB ready: ${dbReady}\n`);
    console.log(`  Endpoints:`);
    console.log(`    GET  /                         → Frontend`);
    console.log(`    GET  /api/player/:tag           → Player profile`);
    console.log(`    GET  /api/brawlers              → All brawlers`);
    console.log(`    POST /api/register/:tag         → Register player + sync battles`);
    console.log(`    GET  /api/battlelog/:tag        → Full stored battle log\n`);
  });

  // Only start the poller if the DB came up
  if (dbReady) {
    setTimeout(runPoller, 5000);
    setInterval(runPoller, POLL_INTERVAL_MS);
  } else {
    // Retry DB init every 2 minutes in case it was a transient failure
    const retryInterval = setInterval(async () => {
      try {
        await db.initSchema();
        console.log('[DB] Reconnected successfully — starting poller.');
        clearInterval(retryInterval);
        setTimeout(runPoller, 1000);
        setInterval(runPoller, POLL_INTERVAL_MS);
      } catch (e) {
        console.warn('[DB] Retry failed:', e.message);
      }
    }, 2 * 60 * 1000);
  }
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
