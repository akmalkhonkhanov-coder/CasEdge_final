'use strict';
/**
 * seawolf-session.js — серверный модуль игры Sea Wolf (CasEdge).
 * Контракт по образцу redrock-session.js.
 *
 * ЖЁСТКОЕ ПРАВИЛО (Г6): валидные трио, счёт и содержимое БУДУЩИХ раундов живут
 * только здесь. Наружу уходит ровно то, что кандидат видит на экране — см. view().
 */
const ATTRS = ['Permeability', 'Size', 'Density'];
const COND_TOTAL = 5;            // 3 средних + есть желательный + нет нежелательного
const PER_COND   = 20;           // %
const SITE_COUNT = 3;
const ROUNDS     = 4;
const POOL_START = 6;
const TIMER_MS   = 30 * 60 * 1000;

/* ═══════════════════════════════════════════════════════════════════════════
   ФАЗА КАТЕГОРИЗАЦИИ · круг 138 цеха игр
   Контракт: 05_документы/SeaWolf_КОНТРАКТ_Insight_Categorize_v1.md

   Банк ОТДЕЛЬНЫЙ от игрового каталога — это утверждение К-2, и оно проверяется
   гейтом по ИМЕНИ и по ТРОЙКЕ ЗНАЧЕНИЙ отдельно: проверка по имени к подсадке
   тройки слепа по построению.

   Размер 120 выведен, а не выдуман. Партия берёт 30 карточек (10 × 3 площадки).
   Игра держит для своего каталога долю 18/72 = 25 %. Требуем ту же долю:
   30/B = 0.25 → B = 120. При банке 36 вторая партия показывала бы 25 из 30
   тех же микробов — втрое хуже собственного стандарта игры.
   ═══════════════════════════════════════════════════════════════════════════ */
const CAT_BANK    = require('./seawolf-microbes.json');
const CAT_PER_SITE = 10;
const CAT_TOTAL    = CAT_PER_SITE * SITE_COUNT;   // 30
/* Показ строки «точность сортировки» в разборе. Ключ ФАЗЫ от него не зависит:
   ключ считается всегда и проверяется гейтом Г-нов-5, показывается — по флагу.
   Слово владельца по вопросу 3 переключает ровно эту константу.

   Круг 141, включено цехом, и вот на каком основании, а не «по вкусу».
   Замер живого прогона: за партию человек делает 30 сортировок — треть всех
   его ходов. При false разбор о них не говорит НИ СЛОВА: ключ считается,
   промахи собираются, и всё это остаётся на сервере. Фаза без обратной связи
   не учит — она просто отнимает время, а предложение владельца звучит
   «проходит три участка С НОВОЙ ФАЗОЙ и видит разбор целиком».
   Откат — одно слово обратно в false; клиент не трогается, строка сама
   исчезает (seawolf.html:1010 рисует её по r.sort.show). */
const SHOW_SORT_ACCURACY = true;

/* РЫЧАГ ОТ КРАСНОГО Г-нов-2 (тривиальность Инсайта, порог 0.50).
 * Замер круга 139 на боевом банке: запас всего 2.9 п.п. Новый банк партий
 * с чуть более просторными участками уводит фазу за порог. Лекарство измерено,
 * а не названо: раскрываемое окно расширяется на N единиц в каждую сторону.
 * Окно остаётся ИСТИННЫМ — диапазон участка лежит ВНУТРИ раскрытого, поэтому
 * правило ключа («попал в раскрытое окно → Next годен») не ломается.
 *
 *   расширение   p_подсказка   подъём   запас до 0.50
 *       0           47.1 %      1.89×      2.9 п.п.   ← сейчас
 *      +1           35.2 %      1.41×     14.8 п.п.   ← лекарство
 *      +2           30.1 %      1.20×     19.9 п.п.
 *      +3           27.5 %      1.10×     22.5 п.п.   подсказка почти пуста
 *
 * ПРАВИЛО ОСТАНОВКИ: при красном гейте ставить 1, гнать гейт заново. Если
 * и на 1 красно — расширять дальше НЕЛЬЗЯ: при +3 подъём 1.10×, подсказка
 * перестаёт быть подсказкой, и лечится уже не Инсайт, а банк партий, который
 * выдал участки, где одна ось решает. Тогда красный гейт отклоняет БАНК.
 */
const INSIGHT_WIDEN = 0;

/* Детерминированный ГСЧ от id партии. Раздача и ось Инсайта НЕ хранятся
   в токене — они выводятся заново при каждой регидратации. Токен носит только
   то, что сделал игрок (см. шапку seawolf-session.js). */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedFrom(str) {
  let h = 2166136261 >>> 0;
  const v = String(str);
  for (let i = 0; i < v.length; i++) { h ^= v.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

/** Раздача 30 РАЗНЫХ карточек банка на три площадки + ось Инсайта на каждый переход. */
function dealCategorization(gameId) {
  const rnd = mulberry32(seedFrom('cat:' + gameId));
  const idx = CAT_BANK.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {         // Фишер–Йейтс на засеянном ГСЧ
    const j = Math.floor(rnd() * (i + 1));
    const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp;
  }
  const cards = [];
  for (let si = 0; si < SITE_COUNT; si++)
    cards.push(idx.slice(si * CAT_PER_SITE, (si + 1) * CAT_PER_SITE).map(i => CAT_BANK[i]));
  /* Ось Инсайта: равновероятно из трёх, независимо на каждом переходе.
     Это НАШЕ правило, объявленное. У PrepMatter оно не выведено — 4 наблюдения. */
  const axes = [];
  for (let si = 0; si < SITE_COUNT - 1; si++) axes.push(ATTRS[Math.floor(rnd() * ATTRS.length)]);
  return { cards, axes };
}

/** Годен ли микроб текущей площадке: ≥2 оси из 3 в диапазоне И нет запрещённого. */
function fitsSite(m, site) {
  let n = 0;
  ATTRS.forEach((k, i) => { const [lo, hi] = site.ranges[k]; if (m[1][i] >= lo && m[1][i] <= hi) n++; });
  return n >= 2 && m[2] !== site.undesired;
}

/**
 * КЛЮЧ СОРТИРОВКИ, редакция круга 135. Взаимоисключаемость ДОКАЗАНА разбором
 * трёх случаев, а не объявлена — первая редакция (круг 134) утверждала её
 * «по построению» и была опровергнута контрпримером Vibrio 6/8/4 на журнале
 * прогона PrepMatter: он подходил И под Current, И под Next одновременно.
 *   current = И                 → next ложен по определению, return ложен
 *   current = Л, сырой next = И → next истинен, return ложен
 *   current = Л, сырой next = Л → next ложен, return истинен
 * Ровно один во всех трёх случаях; иных случаев нет.
 */
function sortKey(m, site, insight) {
  if (fitsSite(m, site)) return 'current';
  if (!insight) return 'return';                     // последняя площадка: Next нет
  const i = ATTRS.indexOf(insight.attr);
  const [lo, hi] = insight.range;
  return (m[1][i] >= lo && m[1][i] <= hi) ? 'next' : 'return';
}
const CAT_ACTIONS = ['current', 'next', 'return'];

/**
 * Калибровочная строка. Ключи — РОВНО уровни партии (Лёгкий · Средний · Сложный):
 * ключ, которого нет в партии, даёт `undefined` на экране, а уровень, которого нет
 * в партии, нельзя называть в тексте. Формулировка — на числах, а не на прилагательных:
 * кандидат должен видеть, во сколько раз тренажёр просторнее ассессмента.
 * Числа — коридор уровня (Г1), а не число решений конкретного набора: последнее было бы
 * подсказкой к текущей партии.
 */
/* ПАРА ЯЗЫКОВ, а не замена. Ключ — уровень партии, он ДАННЫЕ и остаётся русским
   (по нему цех группирует наборы); переводится только печатаемое значение.
   22.08.2026: до этого дня весь текст ниже уезжал кандидату по-русски всегда,
   включая англоязычного и платящего, и стоял он на ПЕРВОМ экране после входа. */
const LEVEL_NOTE = {
  'Лёгкий': {
    ru: '⚠ Тренировочный режим. На этом уровне валидных решений 21–30 из 120 — примерно в 15 раз просторнее реального ассессмента McKinsey, где их 1–2 из 120. Уровень учит порядку ходов, а не жёсткости отбора.',
    en: '⚠ Practice mode. At this level 21-30 of the 120 combinations are valid — roughly 15 times roomier than the real McKinsey assessment, where 1-2 of 120 are. The level teaches the order of moves, not the hardness of the screen.' },
  'Средний': {
    ru: '⚠ Тренировочный режим. На этом уровне валидных решений 8–20 из 120 — примерно в 8 раз просторнее реального ассессмента McKinsey, где их 1–2 из 120. Уровень учит порядку ходов, а не жёсткости отбора.',
    en: '⚠ Practice mode. At this level 8-20 of the 120 combinations are valid — roughly 8 times roomier than the real McKinsey assessment, where 1-2 of 120 are. The level teaches the order of moves, not the hardness of the screen.' },
  'Сложный': {
    ru: '⚠ Тренировочный режим, самый плотный из доступных. На этом уровне валидных решений 3–7 из 120; на реальном ассессменте McKinsey — 1–2 из 120. Разрыв уже небольшой, но он есть: на отборе права на второй заход у тебя нет.',
    en: '⚠ Practice mode, the densest available. At this level 3-7 of the 120 combinations are valid; on the real McKinsey assessment 1-2 of 120. The gap is small now, but it is there: on the screen you get no second run.' },
  'Ассессмент': {
    ru: '● Калибровочный режим. Валидных решений 1–2 из 120 — это плотность реального отбора McKinsey, а не тренажёрная. Сюда заходят по своей воле и без адаптации: уровень не подстроится под тебя, как на настоящем ассессменте.',
    en: '● Calibration mode. 1-2 valid solutions of 120 — the density of the real McKinsey screen, not a trainer one. You come here by choice and without adaptation: the level will not adjust to you, exactly as on the real assessment.' }
};

/* Выбор стороны. Владелец выбора языка в проекте один — refusalLang() в
   _entitlements.js; сюда язык приходит готовым параметром. */
function L(v, lang) {
  if (!v || typeof v !== 'object') return v;
  return String(lang) === 'ru' ? (v.ru || v.en) : (v.en || v.ru);
}
const LEVELS_IN_BATCH = Object.keys(LEVEL_NOTE);

/* ---------- чистые функции счёта ---------- */
const trioSum = (trio, i) => trio[0][1][i] + trio[1][1][i] + trio[2][1][i];

function scoreTrio(trio, site) {
  const detail = [];
  let met = 0;
  ATTRS.forEach((k, i) => {
    const [lo, hi] = site.ranges[k];
    const sum = trioSum(trio, i);
    const ok = sum >= lo * 3 && sum <= hi * 3;
    if (ok) met++;
    detail.push({ attr: k, avg: +(sum / 3).toFixed(2), range: [lo, hi], ok });
  });
  const traits = trio.map(m => m[2]);
  const hasDesired = traits.includes(site.desired);
  const hasUndesired = traits.includes(site.undesired);
  if (hasDesired) met++;
  if (!hasUndesired) met++;
  return { percent: met * PER_COND, met, detail, hasDesired, hasUndesired };
}

function combos3(n) {
  const out = [];
  for (let i = 0; i < n - 2; i++) for (let j = i + 1; j < n - 1; j++) for (let k = j + 1; k < n; k++) out.push([i, j, k]);
  return out;
}
const C3_10 = combos3(10);

function validTrios(pool, site) {
  const out = [];
  // пул бывает короче 10: участок, не доигранный до конца из-за таймера (Г5).
  // Раньше здесь всегда брался C3_10, и разбор такой партии падал на pool[9].
  const combos = pool.length === 10 ? C3_10 : combos3(pool.length);
  for (const [i, j, k] of combos) {
    const trio = [pool[i], pool[j], pool[k]];
    if (scoreTrio(trio, site).percent === 100) out.push([i, j, k]);
  }
  return out;
}

/** максимум валидных трио при идеальной доигровке из префикса выборов */
function bestAhead(site, prefix) {
  let best = 0, bestPath = null;
  const rec = (path) => {
    if (path.length === ROUNDS) {
      const pool = site.start.concat(path.map((o, r) => site.rounds[r][o]));
      const v = validTrios(pool, site).length;
      if (v > best) { best = v; bestPath = path.slice(); }
      return;
    }
    for (let o = 0; o < 3; o++) rec(path.concat(o));
  };
  rec(prefix.slice());
  return { best, bestPath };
}

/* ---------- сессия ---------- */
class SeaWolfSession {
  constructor(game, opts = {}) {
    this.game = game;                     // серверные данные, наружу не отдаются
    // уровень без калибровочной строки — отказ, а не пустое место на экране:
    // именно так «undefined» трижды доезжал до кандидата незамеченным
    if (!LEVEL_NOTE[game.level]) throw new Error(`нет калибровочной строки для уровня «${game.level}»`);
    this.level = game.level;
    this.siteIndex = 0;
    this.round = 0;
    this.choices = [[], [], []];
    this.treatments = [null, null, null];
    this.results = [null, null, null];
    this.startedAt = opts.now ?? Date.now();
    this.siteStartedAt = this.startedAt;      // время по участкам: dev просил, и он прав —
    this.siteMs = [null, null, null];         // сквозной таймер и есть половина трудности
    this.finished = false;

    /* ── фаза категоризации ──────────────────────────────────────────────── */
    const deal = dealCategorization(game.id);
    this.catCards = deal.cards;               // 10 карточек на площадку, выведены из id
    this.insightAxes = deal.axes;             // ось, раскрываемая на переходе si → si+1
    this.catActs = [[], [], []];              // ходы игрока в категоризации
    this.revActs = [[], [], []];              // ходы игрока на экране обзора
    this.forwarded = [[], [], []];            // что ПРИШЛО на площадку si переброской
  }

  /** Инсайт, видимый на площадке si: одна ось, ИСТИННЫЙ диапазон следующей площадки.
      Наружу уходит ровно это — не весь следующий участок (правило Г6). */
  insightAt(si) {
    if (si >= SITE_COUNT - 1) return null;
    const attr = this.insightAxes[si];
    const r = this.game.sites[si + 1].ranges[attr];
    const w = INSIGHT_WIDEN;
    return { attr, range: [Math.max(1, r[0] - w), Math.min(10, r[1] + w)] };
  }

  /** Фаза внутри площадки. Обзор идёт ПЕРВЫМ и только если есть что обозревать. */
  sitePhase() {
    if (this.finished) return 'done';
    const si = this.siteIndex;
    if (this.revActs[si].length < this.forwarded[si].length) return 'review';
    if (this.catActs[si].length < CAT_PER_SITE) return 'categorize';
    return this.round < ROUNDS ? 'prospect' : 'treatment';
  }

  /** Счётчики трёх корзин текущей площадки. Оставленные на обзоре входят
      в Current — утверждение К-5, снято с прогона PrepMatter. */
  catCounts(si = this.siteIndex) {
    const c = { current: 0, next: 0, return: 0 };
    this.revActs[si].forEach(a => { if (a === 'current') c.current++; else c.return++; });
    this.catActs[si].forEach(a => { c[a]++; });
    return c;
  }

  /** Ход категоризации. Переброска кладёт карточку на СЛЕДУЮЩУЮ площадку. */
  categorize(action, now = Date.now(), lang) {
    if (this.finished || this.expired(now)) return this.view(now, lang);
    if (this.sitePhase() !== 'categorize') throw new Error('not in categorize');
    if (!CAT_ACTIONS.includes(action)) throw new Error('bad action');
    const si = this.siteIndex;
    const last = si === SITE_COUNT - 1;
    if (action === 'next' && last) throw new Error('no next site on the last site');
    const card = this.catCards[si][this.catActs[si].length];
    this.catActs[si].push(action);
    if (action === 'next') this.forwarded[si + 1].push(card);
    return this.view(now, lang);
  }

  /** Ход на экране обзора: только Current или Return, кнопки Next здесь нет. */
  review(action, now = Date.now(), lang) {
    if (this.finished || this.expired(now)) return this.view(now, lang);
    if (this.sitePhase() !== 'review') throw new Error('not in review');
    if (action !== 'current' && action !== 'return') throw new Error('bad action');
    this.revActs[this.siteIndex].push(action);
    return this.view(now, lang);
  }
  get site() { return this.game.sites[this.siteIndex]; }
  msLeft(now = Date.now()) { return Math.max(0, TIMER_MS - (now - this.startedAt)); }
  expired(now = Date.now()) { return this.msLeft(now) === 0; }

  /** visible pool: стартовые 6 + уже выбранные */
  pool() { return this.site.start.concat(this.choices[this.siteIndex].map((o, r) => this.site.rounds[r][o])); }

  /** ЕДИНСТВЕННОЕ, что уходит клиенту */
  view(now = Date.now(), lang) {
    if (this.expired(now) && !this.finished) this._timeout();
    const s = this.site;
    const ph = this.sitePhase();
    const si = this.siteIndex;
    /* Что уходит клиенту в фазах обзора и категоризации: ОДНА текущая карточка,
       счётчики и Инсайт. Ни следующая карточка, ни ключ наружу не уходят —
       иначе экран сам бы показал правильный ответ (Г6). */
    let cat = null;
    if (ph === 'categorize') {
      const k = this.catActs[si].length, m = this.catCards[si][k];
      cat = { kind: 'categorize', done: k, total: CAT_PER_SITE,
              card: { name: m[0], a: m[1], trait: m[2] },
              counts: this.catCounts(si), lastSite: si === SITE_COUNT - 1 };
    } else if (ph === 'review') {
      const k = this.revActs[si].length, m = this.forwarded[si][k];
      cat = { kind: 'review', done: k, total: this.forwarded[si].length,
              card: { name: m[0], a: m[1], trait: m[2] },
              counts: this.catCounts(si), lastSite: si === SITE_COUNT - 1 };
    }
    const v = {
      level: this.level, levelNote: L(LEVEL_NOTE[this.level], lang),
      msLeft: this.msLeft(now), siteIndex: this.siteIndex, siteCount: SITE_COUNT,
      phase: this.finished ? 'done' : ph,
      cat,
      insight: this.finished ? null : this.insightAt(si),
      site: { ranges: s.ranges, desired: s.desired, undesired: s.undesired },
      pool: this.pool().map(m => ({ name: m[0], a: m[1], trait: m[2] })),
      round: this.round, roundsTotal: ROUNDS,
      offers: (!this.finished && this.round < ROUNDS)
        ? s.rounds[this.round].map(m => ({ name: m[0], a: m[1], trait: m[2] })) : null,
      scores: this.results.map(r => (r ? r.percent : null))
    };
    return v;
  }

  choose(optionIndex, now = Date.now(), lang) {
    if (this.finished || this.expired(now)) return this.view(now, lang);
    /* Добор не начинается, пока не разобрана категоризация: иначе фаза,
       которая должна стоять ПЕРЕД пулом, оказывалась бы необязательной. */
    if (this.sitePhase() !== 'prospect') throw new Error('categorization incomplete');
    if (this.round >= ROUNDS) throw new Error('pool complete');
    if (!(optionIndex >= 0 && optionIndex < 3)) throw new Error('bad option');
    this.choices[this.siteIndex].push(optionIndex);
    this.round++;
    return this.view(now, lang);
  }

  submit(idx, now = Date.now(), lang) {
    // Партия, уже закрытая (сдана или по таймеру), сдаче не подлежит. Раньше здесь
    // молча возвращался вид «готово», и повторный запрос выглядел как новая партия:
    // сервер записывал результат в историю ещё раз и двигал уровень.
    if (this.finished) throw new Error('партия уже закрыта');
    if (this.expired(now)) { this._timeout(); throw new Error('время вышло'); }
    if (this.round < ROUNDS) throw new Error('pool incomplete');
    /* Индексы приходят из клиентского JSON. Проверяем не «три разных элемента»,
       а «три разных ЦЕЛЫХ индекса внутри пула»: `['0',0,1]` даёт Set из трёх,
       но pool['0'] и pool[0] — один и тот же микроб, то есть лечение из двух. */
    const n = this.pool().length;
    if (!Array.isArray(idx) || idx.length !== 3) throw new Error('need 3 distinct');
    if (!idx.every(i => Number.isInteger(i) && i >= 0 && i < n)) throw new Error('bad trio index');
    if (new Set(idx).size !== 3) throw new Error('need 3 distinct');
    const pool = this.pool();
    const trio = idx.map(i => pool[i]);
    const sc = scoreTrio(trio, this.site);
    this.treatments[this.siteIndex] = idx.slice();
    this.results[this.siteIndex] = sc;                    // счёт по участку показываем сразу
    this.siteMs[this.siteIndex] = now - this.siteStartedAt;
    if (this.siteIndex === SITE_COUNT - 1) this.finished = true;
    else { this.siteIndex++; this.round = 0; this.siteStartedAt = now; }
    return this.view(now, lang);
  }

  _timeout() {                                            // Г5: несданный участок = 0%
    for (let i = 0; i < SITE_COUNT; i++) if (!this.results[i]) this.results[i] = { percent: 0, met: 0, detail: [], timeout: true };
    if (this.siteMs[this.siteIndex] === null) this.siteMs[this.siteIndex] = TIMER_MS - (this.siteStartedAt - this.startedAt);
    this.finished = true;
  }

  /** итог партии: одно место, где он считается — и для сдачи, и для таймаута */
  totals() {
    const per = this.results.map(r => (r ? r.percent : 0));
    return { total: Math.round(per.reduce((a, b) => a + b, 0) / SITE_COUNT), scores: per,
             siteMs: this.siteMs.slice(), usedMs: this.siteMs.reduce((a, b) => a + (b || 0), 0) };
  }

  /** разбор — только после finished. Порядок обратный по времени (У1) */
  reveal(lang) {
    if (!this.finished) throw new Error('reveal before finish');
    return this.game.sites.map((site, si) => {
      const ch = this.choices[si];
      const cost = [];
      let lost = null;
      for (let r = 0; r < ROUNDS; r++) {
        /* Раунд, до которого игрок не дошёл (кончилось время), считается несыгранным.
           Раньше для него `taken` был ложным у всех трёх вариантов, «взятый» запас
           читался как 0 — и разбор обвинял кандидата в ходе, которого он не делал. */
        const played = r < ch.length;
        /* Правка цеха игр, круг 8, перенесена сюда дословно. `bestAhead` считает запас
           по ПРЕФИКСУ ходов, и позиция варианта в префиксе обязана совпадать с номером
           раунда. Здесь стояло `ch.slice(0, r).concat(o)`: на несыгранном раунде
           префикс короче `r`, и вариант раунда 3 считался так, будто берётся на
           раунде 2. Внешне правдоподобно — три одинаковых числа в трёх колонках
           подряд, — и потому глазом не ловилось. Для несыгранного раунда честного
           остатка не существует: он зависит от ходов, которых не было. Такой раунд
           теперь объявляется прочерком, а не считается. */
        const opts = played
          ? [0, 1, 2].map(o => {
              const pre = ch.slice(0, r).concat(o);
              return { name: site.rounds[r][o][0], a: site.rounds[r][o][1], trait: site.rounds[r][o][2],
                       remaining: bestAhead(site, pre).best, taken: ch[r] === o };
            })
          : [0, 1, 2].map(o => ({ name: site.rounds[r][o][0], a: site.rounds[r][o][1], trait: site.rounds[r][o][2],
                       remaining: null, taken: false }));
        cost.push({ round: r + 1, played, options: opts });
        if (!played) continue;
        /* `find` без защиты падал, если в `ch` лежало значение не того типа: партия
           доигрывалась, а разбор — главный товар — не выдавался вовсе. */
        const takenOpt = opts.find(o => o.taken);
        if (!takenOpt) continue;
        const takenRemaining = takenOpt.remaining;
        if (lost === null && takenRemaining === 0 && Math.max(...opts.map(o => o.remaining)) > 0) {
          const should = opts.reduce((a, b) => (b.remaining > a.remaining ? b : a));
          lost = { round: r + 1, took: takenOpt, should, priceFrom: should.remaining, priceTo: takenRemaining };
        }
      }
      /**
       * СЖАТИЕ ЗАПАСА — то, чего нет ни у McKinsey, ни у PrepMatter.
       * `lost` говорит только про ход, обнуливший пул. Но выигранный участок молчит,
       * хотя игрок мог всю партию срезать себе запас: 17 → 12 → 8 → 8. На «Среднем»
       * это сходит с рук, на ассессменте та же игра кончается нулём. Поэтому разбор
       * обязан отличать «ты ошибся» от «ты не дожал» и показывать второе тоже.
       */
      let squeeze = null, kept = 0, cut = 0;
      for (const c of cost) {
        if (!c.played) continue;
        const taken = c.options.find(o => o.taken);
        const best = Math.max(...c.options.map(o => o.remaining));
        if (!taken) continue;
        if (taken.remaining === best) kept++; else cut++;
        const loss = best - taken.remaining;
        if (taken.remaining > 0 && loss > 0 && (!squeeze || loss > squeeze.loss))
          squeeze = { round: c.round, loss, from: best, to: taken.remaining,
                      took: taken, better: c.options.find(o => o.remaining === best) };
      }
      const pool = site.start.concat(ch.map((o, r) => site.rounds[r][o]));
      const vt = validTrios(pool, site);
      const mine = this.treatments[si];
      const spread = ATTRS.map((k, i) => {
        const avgs = vt.map(t => trioSum([pool[t[0]], pool[t[1]], pool[t[2]]], i) / 3);
        return { attr: k, from: avgs.length ? +Math.min(...avgs).toFixed(2) : null, to: avgs.length ? +Math.max(...avgs).toFixed(2) : null };
      });
      /**
       * ДИАГНОЗ УЧАСТКА — один из пяти, и это разные уроки, а не оттенки одного.
       * До этого «не нашёл в пуле» выглядело как «нигде не ошибся»: заголовок хвалил,
       * а провал лежал мелким шрифтом ниже. Заголовок обязан называть тот урок,
       * который человек должен унести.
       */
      const got = this.results[si] ? this.results[si].percent : 0;
      const timedOut = !!(this.results[si] && this.results[si].timeout);
      let verdict;
      if (timedOut && !mine) verdict = { kind: 'notPlayed',
        head: L({ ru: 'Участок не сдан — кончилось время.',
                  en: 'Site not submitted — time ran out.' }, lang),
        body: L({ ru: `Сделано ходов: ${ch.length} из 4. На реальном ассессменте таймер один на три участка, и это половина трудности.`,
                  en: `Moves made: ${ch.length} of 4. On the real assessment one timer covers all three sites, and that is half the difficulty.` }, lang) };
      else if (lost) verdict = { kind: 'lostInDraft',
        head: L({ ru: `Потеряно на доборе, раунд ${lost.round}.`,
                  en: `Lost in the draft, round ${lost.round}.` }, lang),
        body: L({ ru: `Взял ${lost.took.name} — стопроцентных решений осталось ${lost.priceTo}. ${lost.should.name} оставлял ${lost.priceFrom}.`,
                  en: `You took ${lost.took.name} — 100% solutions left: ${lost.priceTo}. ${lost.should.name} would have left ${lost.priceFrom}.` }, lang) };
      /* Ветка `ceiling` («решения не было изначально») удалена цехом игр, круг 9:
         она недостижима по построению, и это доказано перебором, а не рассуждением —
         6075 исходов (25 наборов × 81 ветка × 3 участка), `ceiling` не выпал ни разу.
         У сертифицированного набора `bestAhead(site, [])` ≥ 1 по коридору Г1, значит
         пул мог закрыться только чьим-то ходом, и тогда выставляется `lost`.
         Вердикт, который игрок не может увидеть, — мёртвая ветка, делающая вид,
         что живая. */
      else if (got === 100) verdict = { kind: 'clean',
        head: L({ ru: 'Участок закрыт на 100%.', en: 'Site closed at 100%.' }, lang),
        body: kept === 4
          ? L({ ru: 'И все четыре хода держали максимальный запас — это чистая игра на доборе.',
                en: 'And all four moves held the maximum margin — that is clean drafting.' }, lang)
          : L({ ru: `Но запас ты срезал: лучших ходов ${kept} из 4. На ассессменте, где решений 1–2 из 120, такой ход и есть проигрыш.`,
                en: `But you cut your own margin: best moves ${kept} of 4. On an assessment, where 1-2 of 120 solve it, that move is the loss.` }, lang) };
      else verdict = { kind: 'notFound',
        head: L({ ru: 'Решение у тебя было — ты его не собрал.',
                  en: 'The solution was there — you did not assemble it.' }, lang),
        body: L({ ru: `${vt.length} ${vt.length === 1 ? 'трио давало' : 'трио давали'} 100%, ты сдал трио на ${got}%. Ошибка не на доборе, а на сборке лечения.`,
                  en: `${vt.length} ${vt.length === 1 ? 'trio gave' : 'trios gave'} 100%, you submitted a trio at ${got}%. The error is not in the draft but in assembling the treatment.` }, lang) };

      /* ТОЧНОСТЬ СОРТИРОВКИ. Живёт РЯДОМ со счётом 5 × 20 %, не внутри него:
         эффективность лечения как была 0–100 %, так и осталась.
         База — Return, кнопка ФИКСИРОВАННАЯ и названная ДО раздачи. Первая
         редакция брала «самый частый ключ в этой раздаче» — это потолок оракула,
         кандидату недоступный: он выбирает кнопку, не зная состава. Замер на
         200 000 раздач показал, что при оракульской базе игрок, честно жавший
         Return на все десять, получал МИНУС в 7.9 % партий. */
      const ins = this.insightAt(si);
      const acts = this.catActs[si];
      let sort = null;
      if (acts.length) {
        const keys = this.catCards[si].slice(0, acts.length).map(m => sortKey(m, site, ins));
        const right = keys.filter((k, i) => k === acts[i]).length;
        const base = keys.filter(k => k === 'return').length;
        const misses = [];
        keys.forEach((k, i) => { if (k !== acts[i])
          misses.push({ name: this.catCards[si][i][0], took: acts[i], should: k }); });
        sort = { right, of: acts.length, base,
                 /* Знаменатель вырождается, когда наивная кнопка закрывает всё:
                    тогда точность не измеряется, и это печатается, а не молчится. */
                 net: base >= acts.length ? null : +((right - base) / (acts.length - base)).toFixed(2),
                 degenerate: base >= acts.length, misses,
                 show: SHOW_SORT_ACCURACY };
      }
      return {
        siteIndex: si, levelNote: L(LEVEL_NOTE[this.level], lang),
        verdict, sort,
        lost, cost, squeeze, bestMoves: kept, cutMoves: cut,
        roundsPlayed: ch.length, timedOut,
        yourTrio: mine ? mine.map(i => pool[i][0]) : null,
        yourScore: this.results[si],
        possible: vt.length,
        /* «из 120» стояло в разметке клиента числом. На участке, до которого игрок
           не дошёл, пул состоит из шести стартовых микробов, и сочетаний там 20,
           а не 120: экран сообщал про пул, которого не существовало. Знаменатель
           обязан приезжать оттуда же, откуда числитель. */
        poolSize: pool.length,
        poolCombos: (pool.length * (pool.length - 1) * (pool.length - 2)) / 6,
        /* Г3 требует показать ВСЕ решения и чем они различаются, а разбор показывал
           одно — `vt[0]` — и называл его «примером». Одно решение, выданное за эталон,
           врёт про пул: кандидат не видит, что решений было восемь и что половина
           держалась на одном микробе. Отдаём список целиком плюс ЯДРО — микробы,
           входящие во все решения: это и есть «без чего решения не существует». */
        possibleExample: vt.length ? vt[0].map(i => pool[i][0]) : null,
        possibleAll: vt.map(t => ({
          names: t.map(i => pool[i][0]),
          desiredCount: t.filter(i => pool[i][2] === site.desired).length
        })),
        possibleCore: vt.length ? [...new Set(vt[0])].filter(i => vt.every(tt => tt.includes(i))).map(i => pool[i][0]) : [],
        spread,
        ceilingBelow100: vt.length === 0,
        siteMs: this.siteMs[si] ?? null
      };
    });
  }
}

/* ---------- pick ---------- */
function pick(batch, { level, seenIds = [] } = {}) {
  const pool = batch.filter(g => g.level === level && !seenIds.includes(g.id));
  if (!pool.length) throw new Error('no unseen games for level ' + level);
  return pool[0];
}

module.exports = { SeaWolfSession, pick, scoreTrio, validTrios, bestAhead, ATTRS, LEVEL_NOTE,
                   LEVELS_IN_BATCH, TIMER_MS, L,
                   CAT_BANK, CAT_PER_SITE, CAT_TOTAL, SHOW_SORT_ACCURACY, INSIGHT_WIDEN,
                   dealCategorization, fitsSite, sortKey, mulberry32, seedFrom };
