// CasEdge — Sea Wolf (McKinsey Solve) serverless endpoint.
//
// Why this file exists at all: the workshop's build is a standalone HTTP server
// that keeps sessions in a Map and the player profile in a file on disk. Vercel
// functions do not survive between calls and have no writable disk, so both of
// those disappear here. The split is deliberate:
//
//   · the GAME state travels with the client as a SIGNED, OPAQUE token. It holds
//     only what the player already did — game id, start time, the option indices
//     chosen, the trios submitted and WHEN each site was submitted. Future rounds,
//     valid trios and the debrief are re-derived server-side from the bank and
//     never leave this file until reveal(). The token cannot be forged (HMAC) and
//     rewinding it only replays the player's own moves, so it buys no information.
//   · the PROFILE (games seen, level ladder, history) lives in the client's
//     localStorage and is passed in. It carries no answer key: the worst a player
//     can do by editing it is choose their own difficulty, which is a button on
//     the menu anyway. Putting it on the server would need a table this project
//     does not have.
//
// The registry (seawolf-registry.js) is NOT run here. A full certify() over the
// 150-set bank takes ~27 s — that is an authoring gate, not a request-time gate;
// running it per cold start would spend half the 60 s function budget before the
// player sees a screen. The bank shipped with this endpoint was certified green
// by a full run: 17 classes, 150/150 passed, quarantine empty. A NEW bank must be
// re-certified by the workshop before it is delivered — see BOX_dev_to_seawolf.
//
// Mirrors api/redrock-session.js for CORS, Supabase bearer verification, the
// shared per-user rate limit, body cap and no-leak error handling.
//
// Actions:  state → bank counters · pick → new game {token, view} · view · choose
//           · submit → view (+ totals when the game closes) · reveal

const crypto = require('crypto');
const { SeaWolfSession, LEVEL_NOTE, LEVELS_IN_BATCH } = require('./seawolf-engine.js');
const BANK = require('./seawolf-games.json');

const FALLBACK_ORIGIN = 'https://cas-edge-final.vercel.app';
const MAX_BODY_BYTES = 64 * 1024;
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60 * 1000;
const AUTH_TIMEOUT_MS = 8 * 1000;
const GAMES = Array.isArray(BANK) ? BANK : BANK.games;
const ASSESS = 'Ассессмент';

/* ── token ────────────────────────────────────────────────────────────────── */
// The signing key must be (a) secret, (b) STABLE across cold starts. A random
// per-instance key would kill live sessions with "bad token" and no cause.
// ANTHROPIC_API_KEY is already configured for every other endpoint and never
// leaves the server, so nothing new has to be set up; SEAWOLF_SECRET simply
// overrides it if the key is ever rotated. HMAC never reveals its key.
function secret() {
  const s = process.env.SEAWOLF_SECRET || process.env.ANTHROPIC_API_KEY;
  if (!s) throw new Error('no signing key: set SEAWOLF_SECRET');
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
// Replay the player's own moves. Draws carry no time of their own, so they are
// replayed at the start instant — but each SUBMIT is replayed at the moment it
// actually happened (st.m[site]). That is not bookkeeping: siteMs is computed as
// `now - siteStartedAt` inside submit(), so replaying all three submits at the
// start instant would hand the player a debrief saying every site took 0 seconds,
// and "where the time went" is half of what this debrief is for.
function rehydrate(st) {
  const game = GAMES.find(g => String(g.id) === String(st.g));
  if (!game) return null;
  const s = new SeaWolfSession(game, { now: st.t });
  const ch = Array.isArray(st.c) ? st.c : [[], [], []];
  const tr = Array.isArray(st.s) ? st.s : [null, null, null];
  const at = Array.isArray(st.m) ? st.m : [null, null, null];
  for (let site = 0; site < 3; site++) {
    for (const opt of (ch[site] || [])) s.choose(opt, st.t);
    if (tr[site]) s.submit(tr[site], at[site] || st.t);
  }
  return s;
}
function stateOf(s, st, submittedAt) {
  const m = Array.isArray(st.m) ? st.m.slice() : [null, null, null];
  if (submittedAt != null) {
    // index of the site just closed: submit() has already advanced siteIndex,
    // except on the last site, where it sets finished instead of advancing.
    const i = s.finished ? 2 : s.siteIndex - 1;
    if (i >= 0 && i < 3) m[i] = submittedAt;
  }
  return { g: st.g, t: st.t, c: s.choices, s: s.treatments, m };
}
// Everything the result screen needs that view() does not carry.
function withTotals(s, view) {
  return view.phase === 'done' ? Object.assign({}, view, s.totals()) : view;
}

/* ── bank ─────────────────────────────────────────────────────────────────── */
// The workshop's server picks at random among unseen sets of the level; the
// engine's own pick() returns the first one, which would hand every player the
// same 150 games in the same order. Random is what replayability was measured on.
function pickGame(level, seen) {
  const unseen = GAMES.filter(g => g.level === level && !seen.includes(g.id));
  const pool = unseen.length ? unseen : GAMES.filter(g => g.level === level);
  if (!pool.length) return null;
  return { game: pool[Math.floor(Math.random() * pool.length)], wrapped: !unseen.length, poolSize: pool.length };
}

const { verifyUserCached, subjectOf, rateLimitedScoped } = require('./_auth.js');
const { checkAndConsume, refusalMessage } = require('./_entitlements.js');

/* ── auth + rate limit (same contract as the other endpoints) ─────────────── */
async function fetchWithTimeout(url, options, ms) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...options, signal: c.signal }); } finally { clearTimeout(t); }
}
// verifyUser жил здесь. Теперь один на всё приложение — ./_auth.js,
// с кешем на инстанс. Две копии одной проверки — это C24.
// Same contract as api/drills.js: the RPC is check_and_increment_rate_limit,
// authorised with the CALLER'S token and the anon key. An earlier draft of this
// file invented a different RPC name and a SUPABASE_SERVICE_ROLE_KEY that does
// not exist in this project — every request would have returned 429.
async function rateLimited(userId, sbUrl, sbKey, token) {
  /* Ключ счётчика разведён по ручкам — см. api/_auth.js. До этого все
     восемь ручек делили одну строку, и порог 6 у транскрипции вместе
     с окном 300 секунд действовал на всех. */
  return rateLimitedScoped({ userId, scope: 'seawolf', limit: RATE_LIMIT,
    windowSeconds: RATE_WINDOW_MS / 1000, sbUrl, sbKey, token, timeoutMs: AUTH_TIMEOUT_MS });
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
    const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_ANON_KEY;
    // Проверка токена и счётчик лимита — два независимых похода в Supabase.
    // Раньше они шли по очереди, и вместе давали большую часть задержки хода:
    // замер 06.08 на проде — 1813 мс на action=state, где модели нет вовсе.
    // Счётчику нужен только id пользователя, а он лежит в sub самого токена,
    // поэтому оба запроса стартуют разом. Доверия к sub при этом не появляется:
    // если проверка не прошла — отвечаем 401 и результат счётчика не смотрим,
    // а если sub в токене не тот, что вернул Supabase, это тоже 401.
    const claimSub = subjectOf(bearer);
    const limitP = (sbUrl && sbKey && claimSub)
      ? rateLimited(claimSub, sbUrl, sbKey, bearer).catch(() => false)
      : Promise.resolve(false);
    const user = await verifyUserCached(bearer, AUTH_TIMEOUT_MS);
    if (!user) { limitP.catch(() => {}); return res.status(401).json({ error: { message: 'Invalid or expired session.' } }); }
    if (claimSub && claimSub !== user.id) {
      return res.status(401).json({ error: { message: 'Invalid or expired session.' } });
    }
    let over = await limitP;
    if (!claimSub && sbUrl && sbKey) over = await rateLimited(user.id, sbUrl, sbKey, bearer);
    if (over) return res.status(429).json({ error: { message: 'Too many requests.' } });

    const raw = JSON.stringify(req.body || {});
    if (raw.length > MAX_BODY_BYTES) return res.status(413).json({ error: { message: 'Payload too large.' } });
    const body = req.body || {};
    const action = body.action;
    const seen = Array.isArray(body.seenIds) ? body.seenIds.slice(0, 1000) : [];

    // Bank counters for the menu. levelNote comes from the server for every
    // level and is never copied into the client: a second copy of that text is
    // exactly how the level dictionary drifted apart last time.
    if (action === 'state') {
      const left = {}, totals = {}, levelIds = {};
      for (const lv of LEVELS_IN_BATCH) {
        const ids = GAMES.filter(g => g.level === lv).map(g => g.id);
        levelIds[lv] = ids;
        totals[lv] = ids.length;
        left[lv] = ids.filter(id => !seen.includes(id)).length;
      }
      return res.status(200).json({
        total: GAMES.filter(g => g.level !== ASSESS).length,
        // levelIds lets the client clear "seen" for one level when that level
        // wraps round, instead of forgetting every level at once.
        levels: LEVELS_IN_BATCH, notes: LEVEL_NOTE, remaining: left, totals, levelIds
      });
    }

    if (action === 'pick') {
      const level = typeof body.level === 'string' ? body.level : 'Средний';
      if (!LEVELS_IN_BATCH.includes(level)) return res.status(400).json({ error: { message: 'Unknown level.' } });
      const got = pickGame(level, seen);
      if (!got) return res.status(400).json({ error: { message: 'Level is empty.' } });
      const st = { g: got.game.id, t: Date.now(), c: [[], [], []], s: [null, null, null], m: [null, null, null] };
      const s = rehydrate(st);
      // A level played to the end starts a second lap, and that is announced in
      // words: a repeat you were warned about is a repeat; a silent one reads as
      // "the game ran out".
      const wrapped = got.wrapped
        ? `Уровень «${level}» пройден целиком — все ${got.poolSize} наборов. Дальше идёт второй круг: наборы те же, ты их уже решал. Если нужна новая трудность, а не повтор, открой ассессмент.`
        : null;
      return res.status(200).json({ token: makeToken(st), gameId: got.game.id, level, wrapped, view: s.view() });
    }

    const st = readToken(body.token);
    if (!st) return res.status(400).json({ error: { message: 'Bad or expired game token.' } });
    const s = rehydrate(st);
    if (!s) return res.status(400).json({ error: { message: 'Unknown game.' } });

    if (action === 'view') return res.status(200).json({ token: body.token, view: withTotals(s, s.view()) });

    if (action === 'choose') {

    /* ПРАВА. Списываем ПОСЛЕ того, как человек начал работать, и ровно один раз
       на партию Sea Wolf: ключ расхода идемпотентен, поэтому обрыв связи, перезагрузка
       и повтор того же хода попытку не съедают. Сбой базы пускает (решение
       владельца 09.08.2026) и печатает строку в лог. */
    {
      const ent = await checkAndConsume({ kind: 'games', ref: 'seawolf:' + String(st.g), sbUrl, sbKey, token: bearer });
      if (!ent.allowed) return res.status(402).json({
        error: { message: refusalMessage('games', 'ru'), code: 'entitlement_exhausted' },
        entitlement: { kind: 'games', remaining: 0, cap: ent.cap, used: ent.used }
      });
    }
      const o = body.option;
      if (!(Number.isInteger(o) && o >= 0 && o <= 2)) return res.status(400).json({ error: { message: 'Bad option.' } });
      if (s.finished) return res.status(200).json({ token: body.token, view: withTotals(s, s.view()) });
      if (s.round >= 4) return res.status(400).json({ error: { message: 'Pool complete.' } });
      const view = s.choose(o);
      return res.status(200).json({ token: makeToken(stateOf(s, st)), view: withTotals(s, view) });
    }

    if (action === 'submit') {
      const t = body.trio;
      const ok = Array.isArray(t) && t.length === 3 && t.every(i => Number.isInteger(i) && i >= 0 && i <= 9)
        && new Set(t).size === 3;
      if (!ok) return res.status(400).json({ error: { message: 'Bad trio.' } });
      // Idempotent retry: a blinked network or a double click must return the
      // same result, not an error and not a second game.
      if (s.finished) return res.status(200).json({ token: body.token, view: withTotals(s, s.view()) });
      // Two different failures hide behind one throw, and they are not the same
      // answer. Time ran out → the game is over, hand back the closed view, the
      // player has nothing to fix. Pool not full → the client sent a move that
      // cannot exist, and swallowing it as "done" would print a result screen
      // for a game that was never played.
      if (s.expired()) return res.status(200).json({ token: body.token, view: withTotals(s, s.view()) });
      if (s.round < 4) return res.status(400).json({ error: { message: 'Pool incomplete.' } });
      const now = Date.now();
      const view = s.submit(t, now);
      return res.status(200).json({ token: makeToken(stateOf(s, st, now)), view: withTotals(s, view) });
    }

    // reveal carries the answer key, so it is served ONLY after the game is over
    if (action === 'reveal') {
      // The timer closes a game lazily, inside view(). Asking `finished` before
      // that is asking a question one call too early: a game whose 30 minutes
      // ran out is over, and its debrief was returning 403 instead of the
      // "site not played" verdict the player needs to see.
      s.view();
      if (!s.finished) return res.status(403).json({ error: { message: 'Game not finished.' } });
      return res.status(200).json({ reveal: s.reveal(), totals: s.totals() });
    }

    return res.status(400).json({ error: { message: 'Unknown action.' } });
  } catch (e) {
    console.error('seawolf-session error', e && e.message);
    return res.status(500).json({ error: { message: 'Server error.' } });
  }
}
