// CasEdge — Sea Wolf (McKinsey Solve) serverless endpoint.
//
// Why this file exists at all: the workshop's build is a standalone HTTP server
// that keeps sessions in a Map. Vercel functions do not survive between calls,
// so a Map-backed session loses the player on move two. State therefore travels
// with the client as a SIGNED, OPAQUE token and the server rehydrates from it.
//
// The token carries ONLY what the player already did: game id, start time, the
// option indices chosen, the trios submitted. Future rounds, valid trios and the
// debrief are re-derived server-side from the bank — they never leave this file
// until reveal(). A token cannot be forged (HMAC) and cannot be rewound to gain
// information, because rewinding it only replays the player's own moves.
//
// Mirrors api/redrock-session.js for CORS, Supabase bearer verification, the
// shared per-user rate limit, body cap and no-leak error handling.
//
// Actions:  state → profile · pick → new game {token, view} · view · choose · submit · reveal

const crypto = require('crypto');
const { SeaWolfSession, pick, LEVELS_IN_BATCH } = require('./seawolf-engine.js');
const BANK = require('./seawolf-games.json');

const FALLBACK_ORIGIN = 'https://cas-edge-final.vercel.app';
const MAX_BODY_BYTES = 64 * 1024;
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60 * 1000;
const AUTH_TIMEOUT_MS = 8 * 1000;
const GAMES = Array.isArray(BANK) ? BANK : BANK.games;

/* ── token ────────────────────────────────────────────────────────────────── */
// SEAWOLF_SECRET is required in production. Falling back to a random per-instance
// key would silently invalidate every token on cold start — a session that dies
// mid-game with no error is worse than refusing to start.
function secret() {
  const s = process.env.SEAWOLF_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!s) throw new Error('SEAWOLF_SECRET missing');
  return s;
}
const b64u = b => Buffer.from(b).toString('base64url');
function sign(objStr) {
  return crypto.createHmac('sha256', secret()).update(objStr).digest('base64url');
}
function makeToken(st) {
  const body = b64u(JSON.stringify(st));
  return body + '.' + sign(body);
}
function readToken(tok) {
  if (typeof tok !== 'string' || tok.length > 4096) return null;
  const i = tok.lastIndexOf('.');
  if (i < 1) return null;
  const body = tok.slice(0, i), sig = tok.slice(i + 1);
  const good = sign(body);
  if (sig.length !== good.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (e) { return null; }
}

/* ── rehydrate ────────────────────────────────────────────────────────────── */
// Replay the player's own moves at the ORIGINAL clock so nothing expires during
// reconstruction; the real clock is applied only to the view we hand back.
function rehydrate(st) {
  const game = GAMES.find(g => String(g.id) === String(st.g));
  if (!game) return null;
  const s = new SeaWolfSession(game, { now: st.t });
  const ch = Array.isArray(st.c) ? st.c : [[], [], []];
  const tr = Array.isArray(st.s) ? st.s : [null, null, null];
  for (let site = 0; site < 3; site++) {
    for (const opt of (ch[site] || [])) s.choose(opt, st.t);
    if (tr[site]) s.submit(tr[site], st.t);
  }
  return s;
}
function stateOf(s, st) {
  return { g: st.g, t: st.t, c: s.choices, s: s.treatments };
}

/* ── auth + rate limit (same contract as the other endpoints) ─────────────── */
async function fetchWithTimeout(url, options, ms) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...options, signal: c.signal }); } finally { clearTimeout(t); }
}
async function verifyUser(token) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const r = await fetchWithTimeout(`${url}/auth/v1/user`,
    { headers: { apikey: key, Authorization: 'Bearer ' + token } }, AUTH_TIMEOUT_MS);
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? u : null;
}
async function underRateLimit(userId) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return true;
  try {
    const r = await fetchWithTimeout(`${url}/rest/v1/rpc/check_rate_limit`, {
      method: 'POST',
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_user_id: userId, p_window_seconds: RATE_WINDOW_MS / 1000, p_limit: RATE_LIMIT })
    }, AUTH_TIMEOUT_MS);
    if (!r.ok) { console.error('Sea Wolf rate-limit RPC returned', r.status); return false; }
    return (await r.json()) !== false;
  } catch (e) { console.error('Sea Wolf rate-limit RPC failed'); return false; }
}

/* ── handler ──────────────────────────────────────────────────────────────── */
export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || FALLBACK_ORIGIN;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });

  try {
    const auth = req.headers['authorization'] || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!bearer) return res.status(401).json({ error: { message: 'Authentication required.' } });
    const user = await verifyUser(bearer);
    if (!user) return res.status(401).json({ error: { message: 'Invalid or expired session.' } });
    if (!(await underRateLimit(user.id))) return res.status(429).json({ error: { message: 'Too many requests.' } });

    const raw = JSON.stringify(req.body || {});
    if (raw.length > MAX_BODY_BYTES) return res.status(413).json({ error: { message: 'Payload too large.' } });
    const body = req.body || {};
    const action = body.action;

    if (action === 'state') {
      const seen = Array.isArray(body.seenIds) ? body.seenIds : [];
      const left = {};
      for (const lv of LEVELS_IN_BATCH) left[lv] = GAMES.filter(g => g.level === lv && !seen.includes(g.id)).length;
      return res.status(200).json({ total: GAMES.length, left });
    }

    if (action === 'pick') {
      const level = typeof body.level === 'string' ? body.level : 'Средний';
      if (!LEVELS_IN_BATCH.includes(level)) return res.status(400).json({ error: { message: 'Unknown level.' } });
      const seen = Array.isArray(body.seenIds) ? body.seenIds.slice(0, 500) : [];
      let game;
      try { game = pick(GAMES, { level, seenIds: seen }); }
      catch (e) { return res.status(200).json({ exhausted: level }); }
      const st = { g: game.id, t: Date.now(), c: [[], [], []], s: [null, null, null] };
      const s = rehydrate(st);
      return res.status(200).json({ token: makeToken(st), gameId: game.id, level, view: s.view() });
    }

    const st = readToken(body.token);
    if (!st) return res.status(400).json({ error: { message: 'Bad or expired game token.' } });
    const s = rehydrate(st);
    if (!s) return res.status(400).json({ error: { message: 'Unknown game.' } });

    if (action === 'view') return res.status(200).json({ token: body.token, view: s.view() });

    if (action === 'choose') {
      const o = body.option;
      if (!(Number.isInteger(o) && o >= 0 && o <= 2)) return res.status(400).json({ error: { message: 'Bad option.' } });
      const view = s.choose(o);
      return res.status(200).json({ token: makeToken(stateOf(s, st)), view });
    }

    if (action === 'submit') {
      const t = body.trio;
      const ok = Array.isArray(t) && t.length === 3 && t.every(i => Number.isInteger(i) && i >= 0 && i <= 9)
        && new Set(t).size === 3;
      if (!ok) return res.status(400).json({ error: { message: 'Bad trio.' } });
      const view = s.submit(t);
      return res.status(200).json({ token: makeToken(stateOf(s, st)), view });
    }

    // reveal carries the answer key, so it is served ONLY after the game is over
    if (action === 'reveal') {
      if (!s.finished) return res.status(403).json({ error: { message: 'Game not finished.' } });
      return res.status(200).json({ reveal: s.reveal() });
    }

    return res.status(400).json({ error: { message: 'Unknown action.' } });
  } catch (e) {
    console.error('seawolf-session error', e && e.message);
    return res.status(500).json({ error: { message: 'Server error.' } });
  }
}
