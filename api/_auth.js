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


/* ─────────────────────── счётчик лимитов: ключ по ручке ─────────────────────
   Счётчик один на пользователя, а ручек восемь, и пороги у них разные (6…60),
   и окна разные (60 и 300 секунд). Пока ключ — только userId, ходы одной ручки
   тратят лимит другой:

     · транскрипция объявляет порог 6. Шесть любых запросов чем угодно —
       кейсом, дриллом, Casey — и голосовой ввод отказывает, хотя сам он
       не сделал ни одного вызова;
     · транскрипция же объявляет окно 300 секунд. Строка счётчика одна,
       поэтому минутные пороги остальных ручек начинают считаться
       на пятиминутном окне — то есть впятеро строже, чем написано.

   Разводим ключ: из (userId, ручка) считается детерминированный UUID v5.
   Тип колонки при этом не важен — значение остаётся валидным uuid и валидным
   текстом. Если в таблице стоит внешний ключ на auth.users, RPC откажет,
   и вызов повторяется со старым ключом: поведение возвращается к сегодняшнему,
   а не к «лимитов нет». Результат этой развилки запоминается на инстанс, чтобы
   не платить вторым походом в сеть на каждом запросе. */
const RL_NS = Buffer.from('9f0b7a2c1d344e568a90c1d2e3f4a5b6', 'hex');
function scopedUserId(userId, scope) {
  const h = crypto.createHash('sha1').update(RL_NS).update(String(userId) + ':' + String(scope)).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;   // версия 5
  b[8] = (b[8] & 0x3f) | 0x80;   // вариант RFC 4122
  const x = b.toString('hex');
  return `${x.slice(0,8)}-${x.slice(8,12)}-${x.slice(12,16)}-${x.slice(16,20)}-${x.slice(20)}`;
}

let RL_SCOPED_OK = true;   // на инстанс: развёрнутый ключ принимается базой

async function rlCall(sbUrl, sbKey, token, key, windowSeconds, limit, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(sbUrl + '/rest/v1/rpc/check_and_increment_rate_limit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: sbKey, Authorization: 'Bearer ' + token },
      body: JSON.stringify({ p_user_id: key, p_window_seconds: windowSeconds, p_limit: limit }),
      signal: ctl.signal
    });
  } finally { clearTimeout(t); }
}

/* true = запрос надо отклонить (429). Отказ сети или базы — открываем,
   как и раньше во всех ручках. */
async function rateLimitedScoped({ userId, scope, limit, windowSeconds, sbUrl, sbKey, token, timeoutMs = 5000 }) {
  try {
    if (RL_SCOPED_OK) {
      const r = await rlCall(sbUrl, sbKey, token, scopedUserId(userId, scope), windowSeconds, limit, timeoutMs);
      if (r.ok) return (await r.json()) === false;
      /* Запирать развёрнутый ключ навсегда можно ТОЛЬКО на отказе схемы:
         400 — нарушение типа или внешнего ключа, 404 — функции нет. Пятисотые
         бывают временными, и защёлка по ним отключила бы разведение счётчика
         на весь инстанс из-за одной сетевой икоты. */
      if (r.status === 400 || r.status === 404) {
        RL_SCOPED_OK = false;
        console.error('Rate-limit: scoped key rejected (' + r.status + '), falling back to shared counter');
      } else {
        console.error('Rate-limit RPC returned', r.status);
        return false;
      }
    }
    const r2 = await rlCall(sbUrl, sbKey, token, userId, windowSeconds, limit, timeoutMs);
    if (!r2.ok) { console.error('Rate-limit RPC returned', r2.status); return false; }
    return (await r2.json()) === false;
  } catch (e) {
    console.error('Rate-limit RPC failed:', e);
    return false;
  }
}

module.exports = { verifyUserCached, subjectOf, scopedUserId, rateLimitedScoped, _cache: cache, _claims: claims };
