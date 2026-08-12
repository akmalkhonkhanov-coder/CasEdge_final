/* Общий модуль прав: «можно ли этому человеку ещё один кейс / дрилл / игру».
 *
 * Почему не пишем в user_entitlements напрямую. Таблица прав закрыта от записи
 * из браузера (иначе человек выписал бы себе план из консоли за минуту), а
 * ключа service_role в окружении ручек нет — он есть только у вебхука оплаты.
 * Поэтому расход идёт через функцию базы `consume_entitlement`, которая
 * работает от имени владельца схемы: она сама решает и сама списывает, одним
 * запросом и атомарно. Тот же приём, что уже стоит на счётчике лимитов.
 *
 * Идемпотентность. Списание привязано к `ref` — 'case:312', 'drill:SY-041'.
 * Повторный вызов с тем же ref не спишет второй раз: в журнале расхода стоит
 * первичный ключ (user, kind, ref). Поэтому обрыв связи, перезагрузка страницы
 * и повторная отправка того же хода не съедают попытку. Это дешевле любой
 * попытки «угадать, первый ли это ход» по стенограмме.
 *
 * Поведение при сбое базы — ПУСКАЕМ. Решение владельца от 09.08.2026.
 * Сбой Supabase редок; заплативший, упёршийся в «попытки кончились» по нашей
 * вине, дороже одного бесплатного прохода. Каждый такой случай печатается в лог
 * отдельной строкой `entitlement fail-open`, чтобы это было видно числом,
 * а не ощущением.
 */

const FREE = { cases: 3, drills: 5, games: 0 };   // решение владельца 09.08.2026

const RPC_TIMEOUT_MS = 5000;

/* Ответ, который отдаём, когда база не ответила. Отдельная форма, а не
   подделка успешного ответа: вызывающий обязан иметь возможность отличить
   «разрешено, потому что есть запас» от «разрешено, потому что мы не знаем». */
function failOpen(kind, why) {
  console.error('entitlement fail-open kind=' + kind + ' why=' + String(why));
  return { allowed: true, charged: false, degraded: true, kind, reason: 'db_unavailable' };
}

async function rpc(sbUrl, sbKey, token, args) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), RPC_TIMEOUT_MS);
  try {
    return await fetch(sbUrl + '/rest/v1/rpc/consume_entitlement', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: sbKey,
        Authorization: 'Bearer ' + token
      },
      body: JSON.stringify(args),
      signal: ctl.signal
    });
  } finally { clearTimeout(t); }
}

/**
 * Спросить и списать.
 *   kind  'cases' | 'drills' | 'games'
 *   ref   что тратим: 'case:312'. Один и тот же ref списывается один раз.
 *   peek  true — только посмотреть остаток, не списывать.
 *
 * Возвращает { allowed, charged, remaining, cap, used, degraded?, reason? }.
 * Никогда не бросает.
 */
async function checkAndConsume({ kind, ref, sbUrl, sbKey, token, peek = false, free = null }) {
  if (!FREE.hasOwnProperty(kind)) return failOpen(kind, 'bad kind');
  if (!sbUrl || !sbKey || !token) return failOpen(kind, 'not configured');

  const p_free = Number.isInteger(free) ? free : FREE[kind];
  let r;
  try {
    r = await rpc(sbUrl, sbKey, token, {
      p_kind: kind, p_ref: String(ref || kind), p_free, p_peek: !!peek
    });
  } catch (e) { return failOpen(kind, e); }

  /* 404 — функции в базе ещё нет. Это ровно то состояние, в котором продукт
     живёт до выполнения SQL владельцем, и оно обязано читаться как «проверка
     не проведена», а не как «проверка пройдена». Пускаем (решение владельца),
     но помечаем degraded и кричим в лог. */
  if (!r.ok) return failOpen(kind, 'rpc ' + r.status);

  let out;
  try { out = await r.json(); } catch (e) { return failOpen(kind, 'bad json'); }
  if (!out || typeof out.allowed !== 'boolean') return failOpen(kind, 'bad shape');

  out.kind = kind;
  return out;
}

/** Текст отказа для кандидата. Понятный, а не «403». */
function refusalMessage(kind, lang) {
  const ru = {
    cases:  'Кейсы в вашем плане закончились. Откройте раздел с тарифами, чтобы продолжить.',
    drills: 'Дриллы в вашем плане закончились. Откройте раздел с тарифами, чтобы продолжить.',
    games:  'Игры доступны по Game Pass. Откройте раздел с тарифами.'
  };
  const en = {
    cases:  'You have used all cases in your plan. Open the plans page to continue.',
    drills: 'You have used all drills in your plan. Open the plans page to continue.',
    games:  'Games are part of the Game Pass. Open the plans page.'
  };
  return (String(lang).toLowerCase().startsWith('ru') ? ru : en)[kind] || ru.cases;
}

module.exports = { checkAndConsume, refusalMessage, FREE };
