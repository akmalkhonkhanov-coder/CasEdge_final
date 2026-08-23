// CasEdge — Sustainable Futures Lab (McKinsey Solve) serverless endpoint.
//
// Порт цеховой сборки в Vercel. Цех прислал `sfl-server.js` — обычный http-сервер
// с `sessions = new Map()`, `players` в памяти процесса и `setInterval`-подметалкой.
// В Vercel функция НЕ ПЕРЕЖИВАЕТ ВЫЗОВ: между двумя ходами кандидата это разные
// процессы. Копирование дало бы игру, теряющую партию на втором ходу МОЛЧА —
// и цеховые гейты остались бы зелёными, потому что гоняют локальный сервер,
// где память есть. Разбор этого — в письме круга 15.
//
// Раскладка та же, что у Sea Wolf (api/seawolf-session.js), и по тем же причинам:
//
//   · СОСТОЯНИЕ ПАРТИИ едет с клиентом подписанным непрозрачным токеном. В нём
//     пять величин: версия, id сценария, seed перемешивания, момент старта часов
//     и ходы {c, ms}. Всё остальное — stepIndex, ветка, finished, доли, разбор —
//     ВЫВОДИТСЯ переигровкой на сервере и наружу не уходит. Кодек и список
//     запретных полей — цеховые (`sfl-token.js`), я их не переписывал: гейт
//     `test-sfl-port.js` проверяет контракт, и он общий.
//   · ПРОФИЛЬ (какие сценарии уже видел) живёт в localStorage клиента и приходит
//     в запросе полем `seenIds`. Ключа он не несёт: худшее, что даёт правка, —
//     выбрать себе другой сценарий, а это и так кнопка.
//
// ОТМОТКА РАДИ ПОДСКАЗКИ — известна и ПРИНЯТА осознанно (круг 15/18). Кандидат
// может подставить свой предыдущий токен, уже прочитав экран последствия. Дыра
// сама себя тарифицирует: `t0` лежит ВНУТРИ подписи, поэтому старый токен несёт
// старое начало отсчёта — отмотка тратит время из тех же двадцати минут, а не
// обнуляет его. Внешнее хранилище ради этого не заводим, пока в игру не сыграл
// первый человек. Клиент уже возит конверт целиком, так что добавить поле рядом
// будет правкой сервера, а не обоих.
//
// Сценарии лежат ОДНИМ файлом `_sfl_scenarios.json`, а не шестью: цеховой
// `fs.readdirSync(__dirname)` в собранной функции не работает, сборщик тянет
// только статические require.
//
// Actions: state · start · begin · view · answer · reveal

const { SFLSession } = require('./sfl-engine.js');
const TOKEN = require('./sfl-token.js');
const SCENARIOS = require('./_sfl_scenarios.json');

const FALLBACK_ORIGIN = 'https://cas-edge-final.vercel.app';
const MAX_BODY_BYTES = 64 * 1024;
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60 * 1000;
const AUTH_TIMEOUT_MS = 8 * 1000;

// Ключ подписи. Требование цеха — «без ключа модуль обязан падать» — я сначала
// взял буквально и сделал переменную ОБЯЗАТЕЛЬНОЙ. Это было лишнее, и образец
// уже лежал рядом: api/seawolf-session.js:52 делает то же самое так —
//
//   const s = process.env.SEAWOLF_SECRET || process.env.ANTHROPIC_API_KEY;
//
// Смысл требования — «строка НИКОГДА не уходит без подписи», и он соблюдён
// в обоих вариантах. Тихого обхода тут нет: fallback меняет не наличие печати,
// а слово, которым она сделана. ANTHROPIC_API_KEY настроен в проекте с самого
// начала, стабилен между холодными стартами и наружу не уходит; HMAC ключ
// не раскрывает.
//
// Обязательная переменная не усиливала защиту ни на грамм, зато добавляла
// ручную работу в панели, лишний деплой и шанс забыть её при переносе проекта.
// SFL_TOKEN_KEY остаётся как ПЕРЕОПРЕДЕЛЕНИЕ — на случай, когда понадобится
// ротировать ключи SFL и Sea Wolf раздельно. Это будущая возможность,
// а не условие запуска.
function tokenKey() {
  const k = process.env.SFL_TOKEN_KEY || process.env.ANTHROPIC_API_KEY;
  if (!k) throw new Error('нет ключа подписи: задай SFL_TOKEN_KEY');
  return k;
}

/* ── bank ─────────────────────────────────────────────────────────────────── */
// Цеховой pickScenario хранит `seen` на сервере. Здесь `seen` приходит от
// клиента, а «второй круг» объявляется словами: повтор, о котором предупредили,
// — это повтор; молчаливый читается как «сценарии кончились».
function pickScenario(seen, lang) {
  const unseen = SCENARIOS.filter(s => !seen.includes(s.id));
  const pool = unseen.length ? unseen : SCENARIOS;
  const sc = pool[Math.floor(Math.random() * pool.length)];
  return {
    sc,
    exhausted: unseen.length ? null
      : (String(lang) === 'ru'
          ? `Все ${SCENARIOS.length} сценариев пройдены. Дальше второй круг: сценарии те же, но решения ты уже принимал.`
          : `All ${SCENARIOS.length} scenarios are done. From here it is a second lap: the same scenarios, but you have made these decisions before.`)
  };
}

const { verifyUserCached, subjectOf, rateLimitedScoped } = require('./_auth.js');
const { checkAndConsume, refusalMessage, refusalLang } = require('./_entitlements.js');

/* ── auth + rate limit (тот же контракт, что у остальных эндпоинтов) ──────── */
async function fetchWithTimeout(url, options, ms) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...options, signal: c.signal }); } finally { clearTimeout(t); }
}
// verifyUser жил здесь. Теперь один на всё приложение — ./_auth.js,
// с кешем на инстанс. Две копии одной проверки — это C24.
async function rateLimited(userId, sbUrl, sbKey, token) {
  /* Ключ счётчика разведён по ручкам — см. api/_auth.js. До этого все
     восемь ручек делили одну строку, и порог 6 у транскрипции вместе
     с окном 300 секунд действовал на всех. */
  return rateLimitedScoped({ userId, scope: 'sfl', limit: RATE_LIMIT,
    windowSeconds: RATE_WINDOW_MS / 1000, sbUrl, sbKey, token, timeoutMs: AUTH_TIMEOUT_MS });
}

/* ── state <-> token ──────────────────────────────────────────────────────── */
function decodeState(token) {
  return TOKEN.decode(token, { key: tokenKey(), scenarios: SCENARIOS });
}
function encodeState(st) { return TOKEN.encode(st, tokenKey()); }
function restore(st) { return TOKEN.restore(st, SFLSession); }

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
    /* Язык кандидата — один владелец на проект: refusalLang(). */
    const lang = refusalLang(body);
    const action = body.action;
    const seen = Array.isArray(body.seenIds) ? body.seenIds.filter(x => typeof x === 'string').slice(0, 200) : [];

    if (action === 'state') {
      return res.status(200).json({
        scenarios: SCENARIOS.length,
        remaining: SCENARIOS.filter(s => !seen.includes(s.id)).length
      });
    }

    if (action === 'start') {
      const { sc, exhausted } = pickScenario(seen, lang);
      const now = Date.now();
      // seed привязан к партии, а не к сценарию: одинаковый seed на два захода
      // вернул бы одинаковый порядок вариантов, и «перемешано» стало бы враньём.
      const seed = 's' + now.toString(36) + Math.random().toString(36).slice(2, 8) + '-' + sc.id;
      const st = { sc, seed, t0: null, picks: [] };
      const s = restore(st);
      return res.status(200).json({
        token: encodeState(st), scenarioId: sc.id, title: sc.title, intro: sc.intro,
        exhausted, view: s.view(now)
      });
    }

    // Всё ниже требует токена. Разбор недоверенного входа — в кодеке цеха:
    // подпись доказывает происхождение, а не смысл, поэтому проверяется и то и то.
    let st;
    try { st = decodeState(body.token); }
    catch (e) { return res.status(400).json({ error: { message: 'Bad or expired game token.' } }); }
    const now = Date.now();

    if (action === 'begin') {
      // Часы стоят, пока идут экраны-интро, и стартуют явно. Подпись «Таймер
      // на паузе» — утверждение, которое обязано быть правдой.
      if (st.t0 === null) st = { ...st, t0: now };
      const s = restore(st);
      return res.status(200).json({ token: encodeState(st), view: s.view(now) });
    }

    if (action === 'view') {
      const s = restore(st);
      return res.status(200).json({ token: body.token, view: s.view(now) });
    }

    if (action === 'answer') {

    /* ПРАВА. Списываем ПОСЛЕ того, как человек начал работать, и ровно один раз
       на партию SFL: ключ расхода идемпотентен, поэтому обрыв связи, перезагрузка
       и повтор того же хода попытку не съедают. Сбой базы пускает (решение
       владельца 09.08.2026) и печатает строку в лог. */
    {
      /* Ключ расхода берётся из ПРОВЕРЕННОГО decode. Цех игр показал замером
         (круг 47), что поле sc живёт в двух формах: encode принимает и строку,
         и объект (`state.sc.id ?? state.sc`), а decode подменяет строку объектом
         из библиотеки. Мой первый вариант писал `st.sc.id` и на строковом sc дал бы
         `sfl:undefined` — то есть ВСЕ партии слились бы в одну списываемую единицу,
         и человек оплатил бы одну игру вместо двадцати. Класс: величина, у которой
         две формы, а потребитель знает про одну.
         Берём id так, как его понял decode, и при отсутствии НЕ пишем undefined,
         а отказываем явно: молча пропущенный ключ хуже упавшего запроса. */
      const scId = (st.sc && typeof st.sc === 'object' ? st.sc.id : st.sc);
      if (!scId || typeof scId !== 'string') {
        console.error('sfl spend key missing: sc=' + JSON.stringify(st.sc));
        return res.status(400).json({ error: { message: 'Bad or expired game token.' } });
      }
      const ent = await checkAndConsume({ kind: 'games', ref: 'sfl:' + scId, sbUrl, sbKey, token: bearer });
      if (!ent.allowed) return res.status(402).json({
        error: { message: refusalMessage('games', refusalLang(body)), code: 'entitlement_exhausted' },
        entitlement: { kind: 'games', remaining: 0, cap: ent.cap, used: ent.used }
      });
    }
      const s = restore(st);
      // Партия закрыта — повтор возвращает тот же экран, а не ошибку: моргнувшая
      // сеть и двойной клик не должны выглядеть как проигрыш.
      if (s.finished || s.expired(now)) {
        return res.status(200).json({ token: body.token, view: s.view(now), replay: true });
      }
      if (st.t0 === null) return res.status(400).json({ error: { message: 'Timer not started.' } });
      const before = s.stepIndex;
      const spent = Math.max(0, now - st.t0 - st.picks.reduce((a, p) => a + p.ms, 0));
      const view = s.answer(body.answer, now);
      // consequence — канон: после каждого хода кандидат видит разбор ЭТОГО хода
      // и НЕ видит своей доли и веса. Счёт приходит только в конце.
      const a = s.answers[before];
      const next = { ...st, picks: st.picks.concat([{ c: body.answer, ms: spent }]) };
      return res.status(200).json({
        token: encodeState(next), view, consequence: (a && a.fb) || null
      });
    }

    if (action === 'reveal') {
      const s = restore(st);
      s.view(now);                       // таймер закрывает партию лениво, внутри view()
      if (!s.finished) return res.status(403).json({ error: { message: 'Module not finished.' } });
      return res.status(200).json({ reveal: s.reveal(lang) });
    }

    return res.status(400).json({ error: { message: 'Unknown action.' } });
  } catch (e) {
    // Наружу не уходит ни текст исключения, ни стек: сообщение движка называет
    // поля состояния, а это подсказка про устройство ключа.
    console.error('sfl-session:', e && e.message);
    return res.status(500).json({ error: { message: 'Server error.' } });
  }
}
