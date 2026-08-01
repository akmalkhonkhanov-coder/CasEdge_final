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

/**
 * Калибровочная строка. Ключи — РОВНО уровни партии (Лёгкий · Средний · Сложный):
 * ключ, которого нет в партии, даёт `undefined` на экране, а уровень, которого нет
 * в партии, нельзя называть в тексте. Формулировка — на числах, а не на прилагательных:
 * кандидат должен видеть, во сколько раз тренажёр просторнее ассессмента.
 * Числа — коридор уровня (Г1), а не число решений конкретного набора: последнее было бы
 * подсказкой к текущей партии.
 */
const LEVEL_NOTE = {
  'Лёгкий':  '⚠ Тренировочный режим. На этом уровне валидных решений 21 и больше из 120 — примерно в 15 раз просторнее реального ассессмента McKinsey, где их 1–2 из 120. Уровень учит порядку ходов, а не жёсткости отбора.',
  'Средний': '⚠ Тренировочный режим. На этом уровне валидных решений 8–20 из 120 — примерно в 8 раз просторнее реального ассессмента McKinsey, где их 1–2 из 120. Уровень учит порядку ходов, а не жёсткости отбора.',
  'Сложный': '⚠ Тренировочный режим, самый плотный из доступных. На этом уровне валидных решений 3–7 из 120; на реальном ассессменте McKinsey — 1–2 из 120. Разрыв уже небольшой, но он есть: на отборе права на второй заход у тебя нет.',
  'Ассессмент': '● Калибровочный режим. Валидных решений 1–2 из 120 — это плотность реального отбора McKinsey, а не тренажёрная. Сюда заходят по своей воле и без адаптации: уровень не подстроится под тебя, как на настоящем ассессменте.'
};
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
  }
  get site() { return this.game.sites[this.siteIndex]; }
  msLeft(now = Date.now()) { return Math.max(0, TIMER_MS - (now - this.startedAt)); }
  expired(now = Date.now()) { return this.msLeft(now) === 0; }

  /** visible pool: стартовые 6 + уже выбранные */
  pool() { return this.site.start.concat(this.choices[this.siteIndex].map((o, r) => this.site.rounds[r][o])); }

  /** ЕДИНСТВЕННОЕ, что уходит клиенту */
  view(now = Date.now()) {
    if (this.expired(now) && !this.finished) this._timeout();
    const s = this.site;
    const v = {
      level: this.level, levelNote: LEVEL_NOTE[this.level],
      msLeft: this.msLeft(now), siteIndex: this.siteIndex, siteCount: SITE_COUNT,
      phase: this.finished ? 'done' : (this.round < ROUNDS ? 'prospect' : 'treatment'),
      site: { ranges: s.ranges, desired: s.desired, undesired: s.undesired },
      pool: this.pool().map(m => ({ name: m[0], a: m[1], trait: m[2] })),
      round: this.round, roundsTotal: ROUNDS,
      offers: (!this.finished && this.round < ROUNDS)
        ? s.rounds[this.round].map(m => ({ name: m[0], a: m[1], trait: m[2] })) : null,
      scores: this.results.map(r => (r ? r.percent : null))
    };
    return v;
  }

  choose(optionIndex, now = Date.now()) {
    if (this.finished || this.expired(now)) return this.view(now);
    if (this.round >= ROUNDS) throw new Error('pool complete');
    if (!(optionIndex >= 0 && optionIndex < 3)) throw new Error('bad option');
    this.choices[this.siteIndex].push(optionIndex);
    this.round++;
    return this.view(now);
  }

  submit(idx, now = Date.now()) {
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
    return this.view(now);
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
  reveal() {
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
        head: 'Участок не сдан — кончилось время.',
        body: `Сделано ходов: ${ch.length} из 4. На реальном ассессменте таймер один на три участка, и это половина трудности.` };
      else if (lost) verdict = { kind: 'lostInDraft',
        head: `Потеряно на доборе, раунд ${lost.round}.`,
        body: `Взял ${lost.took.name} — стопроцентных решений осталось ${lost.priceTo}. ${lost.should.name} оставлял ${lost.priceFrom}.` };
      else if (vt.length === 0) verdict = { kind: 'ceiling',
        head: `Стопроцентного решения в этом пуле не было — потолок ${got}%.`,
        body: 'Ни один ход не был единственной причиной: пул закрылся не одним решением, а их сочетанием.' };
      else if (got === 100) verdict = { kind: 'clean',
        head: 'Участок закрыт на 100%.',
        body: kept === 4 ? 'И все четыре хода держали максимальный запас — это чистая игра на доборе.'
                         : `Но запас ты срезал: лучших ходов ${kept} из 4. На ассессменте, где решений 1–2 из 120, такой ход и есть проигрыш.` };
      else verdict = { kind: 'notFound',
        head: 'Решение у тебя было — ты его не собрал.',
        body: `${vt.length} ${vt.length === 1 ? 'трио давало' : 'трио давали'} 100%, ты сдал трио на ${got}%. Ошибка не на доборе, а на сборке лечения.` };

      return {
        siteIndex: si, levelNote: LEVEL_NOTE[this.level],
        verdict,
        lost, cost, squeeze, bestMoves: kept, cutMoves: cut,
        roundsPlayed: ch.length, timedOut,
        yourTrio: mine ? mine.map(i => pool[i][0]) : null,
        yourScore: this.results[si],
        possible: vt.length,
        possibleExample: vt.length ? vt[0].map(i => pool[i][0]) : null,
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

module.exports = { SeaWolfSession, pick, scoreTrio, validTrios, bestAhead, ATTRS, LEVEL_NOTE, LEVELS_IN_BATCH, TIMER_MS };
