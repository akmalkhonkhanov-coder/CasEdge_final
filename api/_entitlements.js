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

/* КЕШ УЖЕ ОПЛАЧЕННОГО.
   Найден цехом игр (круг 48): проверка стоит на КАЖДОМ ходу, а списание
   идемпотентно по ref - то есть партия SFL из двенадцати ходов делала
   двенадцать походов в базу, из которых одиннадцать заведомо возвращали
   "уже оплачено". То же на кейсе (восемь шагов и повторы) и на Redrock
   (поле за полем). Это не двойное списание, но это лишняя сетевая задержка
   на каждом ходу и лишний расход общего счётчика лимитов.

   Кешируем ТОЛЬКО положительный ответ по конкретному ref. Отказы не кешируются
   никогда - иначе одна сетевая икота заперла бы живого человека до конца TTL;
   ровно тот класс, за который в api/_auth.js стоит отдельный комментарий.
   Ключ включает токен: без него сосед по инстансу получил бы чужую
   оплаченную партию - это тот же класс, что стоил нам ключа кеша по хвосту JWT.

   TTL 30 минут: партия SFL идёт восемь минут, кейс до сорока. Инстансы Vercel
   живут между вызовами, поэтому подряд идущие ходы одной партии почти всегда
   попадают в один инстанс, а значит и в кеш. */
const PAID_TTL_MS = 30 * 60 * 1000;
const MAX_PAID = 2000;
const paid = new Map();   // key -> until

const crypto = require('crypto');
function paidKey(token, kind, ref) {
  return crypto.createHash('sha256')
    .update(String(token)).update(' ').update(String(kind)).update(' ').update(String(ref))
    .digest('base64');
}
function paidHit(k) {
  const until = paid.get(k);
  if (until === undefined) return false;
  if (until <= Date.now()) { paid.delete(k); return false; }
  return true;
}
function paidRemember(k) {
  if (paid.size >= MAX_PAID) paid.clear();
  paid.set(k, Date.now() + PAID_TTL_MS);
}

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

  /* КЛЮЧ РАСХОДА ОБЯЗАН БЫТЬ. Найдено цехом игр (круг 49): при пустом ref
     строка схлопывалась в само имя вида ('games'), и ВСЕ партии человека
     становились одной списываемой единицей - купивший 75 игр оплатил бы одну.
     Тот же класс, что уже стоил нам 'sfl:undefined': величина, у которой нет
     значения, тихо превращается в общее для всех значение.
     Сюда же ловится 'case:undefined' - хвост, дописанный к живому имени вида.
     Не списываем и не отказываем человеку: пускаем, помечаем degraded и кричим
     в лог. Ошибка наша, платить за неё кандидату не за что. */
  /* Тип проверяется ДО String(). Найдено цехом игр (круг 50) замером, а не догадкой:
     String({}) даёт «[object Object]», String(NaN) даёт «NaN» - и фильтр пустоты,
     стоящий ПОСЛЕ приведения, обе формы пропускает. Снова один ключ на все партии.
     Путь не выдуманный: поле sc в SFL уже живёт в двух формах, строкой и объектом,
     и следующий, кто соберёт ref из объекта, сделает это молча. */
  if (typeof ref !== 'string' && typeof ref !== 'number') {
    return failOpen(kind, 'ref is ' + (ref === null ? 'null' : typeof ref));
  }
  if (typeof ref === 'number' && !Number.isFinite(ref)) {
    return failOpen(kind, 'ref is not a finite number');
  }
  const refStr = String(ref).trim();
  if (!refStr || refStr === kind || /(^|:)undefined$|(^|:)null$|:$/.test(refStr)) {
    return failOpen(kind, 'bad ref "' + refStr + '"');
  }

  const p_free = Number.isInteger(free) ? free : FREE[kind];

  /* За эту партию в этом инстансе уже платили - в базу не идём вовсе. */
  const pk = paidKey(token, kind, refStr);
  if (!peek && paidHit(pk)) {
    return { allowed: true, charged: false, cached: true, kind, reason: 'already_paid' };
  }

  let r;
  try {
    r = await rpc(sbUrl, sbKey, token, {
      p_kind: kind, p_ref: refStr, p_free, p_peek: !!peek
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
  /* Запоминаем только "пустили": и списание, и "уже оплачено" означают,
     что за этот ref платить больше не нужно. Отказ не запоминаем. */
  if (!peek && out.allowed === true) paidRemember(pk);
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
