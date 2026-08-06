/* Общая проверка сессии Supabase с кешем в памяти инстанса.
 *
 * Зачем: каждый эндпоинт на каждый вызов ходил в /auth/v1/user. Замер на проде
 * 06.08: sfl-session action=state — 1813 мс на запрос, который только считает
 * сценарии. Модель тут не участвует вовсе; время уходит в два последовательных
 * сетевых похода в Supabase (проверка токена и счётчик лимита).
 *
 * Что делает кеш: на тёплом инстансе повторная проверка того же токена не идёт
 * в сеть. Инстансы у Vercel живут между вызовами, поэтому подряд идущие ходы
 * одной партии почти всегда попадают в один инстанс.
 *
 * Чего кеш НЕ делает и почему это важно:
 *   · не кеширует отказы — иначе одна сетевая икота запирала бы живого человека
 *     на весь TTL;
 *   · не живёт дольше самого токена: TTL всегда обрезается по «exp» из тела
 *     JWT, поэтому просроченный токен не может быть принят из кеша;
 *   · не растёт бесконечно — при переполнении карта чистится целиком.
 *
 * Тело JWT читается БЕЗ проверки подписи и только для двух вещей: обрезать TTL
 * и достать sub для параллельного запуска счётчика лимита. Доверяем мы не ему,
 * а ответу Supabase, который кладётся в кеш уже проверенным.
 */

const TTL_MS = 60 * 1000;
const MAX_ENTRIES = 500;
const SKEW_MS = 5 * 1000;

const cache = new Map();   // tokenKey -> { user, until }

const crypto = require('crypto');

function keyOf(token) {
  // Ключ — sha256 полного токена. Сам токен в памяти не лежит.
  //
  // Первая версия брала хвост в 24 символа плюс длину, и гейт тут же показал,
  // почему так нельзя: у JWT поле sub стоит В НАЧАЛЕ тела, а подпись у двух
  // токенов одного проекта одинаковой длины. Хвосты совпадали — и два РАЗНЫХ
  // пользователя получали один ключ. Это не медленность, это выдача чужой
  // сессии. Экономия на хеше стоила бы подмены личности.
  return crypto.createHash('sha256').update(String(token)).digest('base64');
}

/** Тело JWT без проверки подписи. null, если это не разборный JWT. */
function claims(token) {
  try {
    const p = String(token).split('.')[1];
    if (!p) return null;
    const b64 = p.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (e) { return null; }
}

/** sub из токена — нужен, чтобы стартовать счётчик лимита не дожидаясь проверки. */
function subjectOf(token) {
  const c = claims(token);
  return c && typeof c.sub === 'string' ? c.sub : null;
}

function cachedUser(token) {
  const k = keyOf(token);
  const hit = cache.get(k);
  if (!hit) return null;
  if (hit.until <= Date.now()) { cache.delete(k); return null; }
  return hit.user;
}

function remember(token, user) {
  const c = claims(token);
  let until = Date.now() + TTL_MS;
  if (c && typeof c.exp === 'number') {
    const expMs = c.exp * 1000 - SKEW_MS;
    if (expMs < until) until = expMs;          // кеш не переживает свой токен
  }
  if (until <= Date.now()) return;             // уже просрочен — не кладём
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(keyOf(token), { user, until });
}

function fetchWithTimeout(url, options, ms) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...options, signal: c.signal }).finally(() => clearTimeout(t));
}

/**
 * Возвращает объект пользователя Supabase или null.
 * Контракт тот же, что был у локальных verifyUser в каждом файле.
 */
async function verifyUserCached(token, timeoutMs) {
  if (!token) return null;
  const hit = cachedUser(token);
  if (hit) return hit;

  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  let r;
  try {
    r = await fetchWithTimeout(`${url}/auth/v1/user`,
      { headers: { apikey: key, Authorization: 'Bearer ' + token } }, timeoutMs || 8000);
  } catch (e) { return null; }
  if (!r.ok) return null;
  let u;
  try { u = await r.json(); } catch (e) { return null; }
  if (!u || !u.id) return null;
  remember(token, u);
  return u;
}

module.exports = { verifyUserCached, subjectOf, _cache: cache, _claims: claims };
