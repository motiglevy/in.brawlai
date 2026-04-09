'use strict';

const { Pool } = require('pg');

// ── Connection pool ─────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

// ── Schema bootstrap (runs once on startup) ─────────────────────────────────
async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS registered_players (
        player_tag    TEXT PRIMARY KEY,
        player_name   TEXT,
        first_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_polled   TIMESTAMPTZ
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS battles (
        id              BIGSERIAL PRIMARY KEY,
        player_tag      TEXT        NOT NULL,
        battle_time     TIMESTAMPTZ NOT NULL,
        mode            TEXT,
        map             TEXT,
        result          TEXT,
        brawler_name    TEXT,
        brawler_power   INTEGER,
        trophies_change INTEGER,
        raw_json        JSONB,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT battles_unique UNIQUE (player_tag, battle_time, mode, map)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS battles_player_tag_idx
        ON battles (player_tag, battle_time DESC);
    `);

    console.log('[DB] Schema ready.');
  } finally {
    client.release();
  }
}

// ── Register a player (called on login) ─────────────────────────────────────
async function registerPlayer(tag, name) {
  await pool.query(`
    INSERT INTO registered_players (player_tag, player_name)
    VALUES ($1, $2)
    ON CONFLICT (player_tag) DO UPDATE
      SET player_name = EXCLUDED.player_name
  `, [tag, name || null]);
}

// ── Save new battles (skips duplicates) ─────────────────────────────────────
async function saveBattles(playerTag, battles) {
  if (!battles || battles.length === 0) return 0;

  let inserted = 0;
  for (const b of battles) {
    try {
      const event    = b.event   || {};
      const battle   = b.battle  || {};
      const players  = battle.teams
        ? battle.teams.flat()
        : (battle.players || []);

      // Find this player's brawler in the battle
      const self = players.find(p =>
        p.tag && p.tag.replace('#', '') === playerTag.replace('#', '')
      );
      const brawler = self?.brawler || {};

      // Parse battle timestamp: "20240315T143022.000Z" → ISO
      const rawTime = b.battleTime || '';
      const isoTime = rawTime.replace(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/,
        '$1-$2-$3T$4:$5:$6'
      );

      const result = await pool.query(`
        INSERT INTO battles
          (player_tag, battle_time, mode, map, result,
           brawler_name, brawler_power, trophies_change, raw_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT ON CONSTRAINT battles_unique DO NOTHING
      `, [
        playerTag,
        isoTime || null,
        event.mode        || null,
        event.map         || null,
        battle.result     || null,
        brawler.name      || null,
        brawler.power     || null,
        // Battle-level trophyChange first; fall back to player-level (Showdown etc.)
        battle.trophyChange !== undefined
          ? battle.trophyChange
          : (self?.trophyChange !== undefined ? self.trophyChange : null),
        JSON.stringify(b),
      ]);

      if (result.rowCount > 0) inserted++;
    } catch (err) {
      console.error('[DB] saveBattle error:', err.message);
    }
  }
  return inserted;
}

// ── Get all battles for a player ────────────────────────────────────────────
async function getBattles(playerTag, limit = 500) {
  const { rows } = await pool.query(`
    SELECT
      battle_time,
      mode,
      map,
      result,
      brawler_name,
      brawler_power,
      trophies_change,
      raw_json
    FROM battles
    WHERE player_tag = $1
    ORDER BY battle_time DESC
    LIMIT $2
  `, [playerTag, limit]);
  return rows;
}

// ── Get all registered players (for the poller) ──────────────────────────────
async function getRegisteredPlayers() {
  const { rows } = await pool.query(
    'SELECT player_tag FROM registered_players ORDER BY last_polled ASC NULLS FIRST'
  );
  return rows.map(r => r.player_tag);
}

// ── Mark player as just polled ───────────────────────────────────────────────
async function markPolled(playerTag) {
  await pool.query(
    'UPDATE registered_players SET last_polled = NOW() WHERE player_tag = $1',
    [playerTag]
  );
}

module.exports = {
  initSchema,
  registerPlayer,
  saveBattles,
  getBattles,
  getRegisteredPlayers,
  markPolled,
};
