'use strict';
/**
 * sfl-session.js — серверный модуль SFL (CasEdge). МАКЕТ до появления канона.
 *
 * Контракт тот же, что у Sea Wolf: наружу уходит ровно то, что кандидат видит
 * на экране. Ключи вариантов, доли, веса суб-признаков и содержимое будущих шагов
 * живут только здесь.
 *
 * Три отличия от PrepMatter, каждое объявлено (см. SFL_ЭТАЛОН_v1 §3.3):
 *   1. пропуск = 0, а не `Not scored`;
 *   2. согласованность с собственным объявленным порядком считается ЧИСЛОМ;
 *   3. сценарий действительно ветвится — иначе согласованность нечем измерять.
 */
const TRAITS = ['Prioritisation', 'Decision-making under uncertainty', 'Interpreting messy information',
                'Balancing trade-offs', 'Team and stakeholder effectiveness'];
const SHARES = [0, 0.2, 0.4, 0.6, 1.0];   // объявленный набор долей (Ф4)

/** ранжирование: доля = 1 − нормированное расстояние Кендалла до ключа */
/* ПАРА ЯЗЫКОВ для трёх строк разбора, которые кандидат читает. Остальные
   тексты SFL приходят из сценариев, а они уже английские (language: en у всех
   20). Выбор стороны — тем же способом, что в Sea Wolf и в кассе. */
function L(v, lang) {
  if (!v || typeof v !== 'object') return v;
  return String(lang) === 'ru' ? (v.ru || v.en) : (v.en || v.ru);
}

/* ПАРА ДЛЯ ПОЛЯ СЦЕНАРИЯ. Цех игр 23.08 отдал `why` по-английски и положил
   рядом `_why_ru` — русский оригинал. Подчёркивание не именное правило: ключ
   с «_» снимается ОБЩЕЙ конвенцией внутреннего, поэтому ни один гейт не обязан
   знать про него отдельно.
   Выбор стороны стоит здесь, а не в теле сценария: владелец языка на проекте
   один. Пары ещё нет в боевом файле — тогда возвращается `why`, и поведение
   ровно прежнее. */
function pickRu(obj, field, lang) {
  if (!obj) return null;
  if (String(lang) === 'ru') {
    const v = obj['_' + field + '_ru'];
    if (typeof v === 'string' ? v.trim() !== '' : v != null) return v;
  }
  return obj[field];
}

function rankShare(answer, key) {
  if (!Array.isArray(answer) || answer.length !== key.length) return 0;
  if (new Set(answer).size !== key.length || !answer.every(x => key.includes(x))) return 0;
  const pos = Object.fromEntries(answer.map((id, i) => [id, i]));
  let inv = 0, pairs = 0;
  for (let i = 0; i < key.length; i++) for (let j = i + 1; j < key.length; j++) {
    pairs++; if (pos[key[i]] > pos[key[j]]) inv++;
  }
  return 1 - inv / pairs;                  // 1.0 точный порядок · 0.0 полностью обратный
}

/** детерминированная перестановка: seed → порядок. Своя, чтобы прогон был воспроизводим
 *  и чтобы гейт мог назвать перестановку числом, а не «как повезёт». */
function shuffleBy(list, seed) {
  let h = 2166136261 >>> 0;
  for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    h = (Math.imul(h, 1103515245) + 12345) >>> 0;
    /* 28.08.2026, замер цеха игр, воспроизведён у dev на 200 000 посевов.
       `h % (i + 1)` брало МЛАДШИЕ биты ЛКГ: у них период 2 и 4, и тасовка
       Фишера-Йетса переставала быть равномерной. Набор из 4 пунктов давал
       12 порядков из 24, первый по файлу пункт возглавлял 33.3% вместо 25%.
       Берём СТАРШИЕ биты: 24 порядка из 24, первый пункт 24.8%. */
    const j = Math.floor((h / 4294967296) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class SFLSession {
  constructor(scenario, opts = {}) {
    this.sc = scenario;
    /* ТАЙМЕР НЕ ИДЁТ, ПОКА ИДУТ ЭКРАНЫ-ИНТРО. Экраны подписаны «Таймер на паузе»
       и «20:00», а отсчёт шёл от момента создания сессии: за двадцать секунд чтения
       брифа сгорало двадцать секунд из двадцати минут, и первый вопрос открывался
       на 19:38. Подпись на экране была не украшением, а утверждением, и утверждение
       было ложным. Часы стартуют явным begin(), а до него стоят. */
    this.startedAt = null;
    this.stepIndex = 0;                    // 0..12
    this.answers = [];                     // {n, choice, share, branch, ms}
    this.branch = null;                    // текущая ветка алмаза
    this.stepStartedAt = null;
    this.finished = false;
    /* ПОРЯДОК ВАРИАНТОВ НА ЭКРАНЕ. В обоих сценариях сильный вариант стоял первым
       и всегда имел id `a`, а стартовый порядок приоритетов совпадал с ключом.
       Кандидат набирал 10.0/10, не прочитав ни одного слова: «жми первый пункт,
       ранжирование не трогай». Инструмент измерял умение кликать. Порядок теперь
       перемешивается на СЕРВЕРЕ и свой на каждую сессию. */
    this.seed = opts.seed ?? ('s' + Math.floor((opts.now ?? Date.now()) % 1e9) + '-' + this.sc.id);
  }
  /** явный старт часов: до него msLeft() = полный таймер */
  begin(now = Date.now()) {
    if (this.startedAt === null) { this.startedAt = now; this.stepStartedAt = now; }
    return this;
  }
  get started() { return this.startedAt !== null }
  get timerMs() { return this.sc.timerMs }
  msLeft(now = Date.now()) {
    if (this.startedAt === null) return this.timerMs;
    return Math.max(0, this.timerMs - (now - this.startedAt));
  }
  expired(now = Date.now()) { return this.startedAt !== null && this.msLeft(now) === 0 }

  /** шаг с учётом ветки: у ветвящихся шагов текст берётся из variants */
  step(i = this.stepIndex) {
    const s = this.sc.steps[i];
    if (!s.variants) return s;
    const v = s.variants[this.branch] || s.variants[Object.keys(s.variants)[0]];
    return { ...s, prompt: v.prompt, options: v.options, _variant: this.branch };
  }
  /** порядок ПОКАЗА вариантов шага: свой на каждую сессию, стабильный внутри неё */
  shownOptions(i = this.stepIndex) {
    const s = this.step(i);
    if (s.type !== 'choice') return undefined;
    return shuffleBy(s.options, this.seed + ':o' + s.n + ':' + (s._variant || '-'));
  }
  /** порядок ПОКАЗА пунктов ранжирования: тоже перемешан, иначе стартовый = ключ */
  shownItems() { return shuffleBy(this.sc.priorities, this.seed + ':r'); }

  /** ЕДИНСТВЕННОЕ, что уходит клиенту (Г6 по аналогии с Sea Wolf) */
  view(now = Date.now()) {
    if (this.expired(now) && !this.finished) this._timeout();
    if (this.finished) return { phase: 'done', msLeft: 0, total: this.stepIndex, scores: this.score().traits };
    const s = this.step();
    return {
      phase: 'question',
      msLeft: this.msLeft(now),
      n: s.n, of: this.sc.steps.length,
      type: s.type,
      prompt: s.prompt,
      items: s.type === 'rank' ? this.shownItems() : undefined,
      options: s.type === 'choice' ? this.shownOptions().map(o => ({ id: o.id, text: o.text })) : undefined,
      title: this.sc.title
    };
  }

  answer(payload, now = Date.now()) {
    if (this.finished) throw new Error('модуль уже закрыт');
    /* Ответ, пришедший до явного begin(), сам объявляет старт: часы не могут стоять
       после того, как кандидат уже отвечает на вопрос. */
    if (this.startedAt === null) this.begin(now);
    if (this.expired(now)) { this._timeout(); throw new Error('время вышло'); }
    const s = this.step();
    let share, choice, fb;
    if (s.type === 'rank') {
      share = rankShare(payload, s.key);
      choice = Array.isArray(payload) ? payload.slice() : null;
      fb = share >= 0.99 ? s.feedback.top : share >= 0.5 ? s.feedback.mid : s.feedback.low;
    } else {
      const o = s.options.find(x => x.id === payload);
      if (!o) throw new Error('нет такого варианта');
      share = o.share; choice = o.id; fb = o.fb;
      if (o.next) this.branch = o.next;    // алмаз: ветка выбирается ходом кандидата
    }
    this.answers.push({ n: s.n, trait: s.trait, sub: s.sub, choice, share, fb,
                        priorityTag: s.priorityTag || null, variant: s._variant || null,
                        ms: now - this.stepStartedAt });
    this.stepStartedAt = now;
    this.stepIndex++;
    if (this.stepIndex >= this.sc.steps.length) this.finished = true;
    return this.view(now);
  }

  /** Ф8: пропуск = 0 на всех путях, включая таймаут */
  _timeout() {
    for (let i = this.stepIndex; i < this.sc.steps.length; i++) {
      const s = this.sc.steps[i];
      /* Ветка у пропущенного шага не записывалась, и разбор показывал сильный ход
         из ветки, в которой кандидат не был: урок давался по чужому экрану. */
      this.answers.push({ n: s.n, trait: s.trait, sub: s.sub, choice: null, share: 0,
                          fb: null, priorityTag: s.priorityTag || null, skipped: true,
                          variant: s.variants ? (this.branch || Object.keys(s.variants)[0]) : null,
                          ms: 0 });
    }
    /* Время на шаге, где кандидат просидел до конца таймера, — не ноль. `usedMs`
       суммировал только отвеченные шаги, и партия, где человек двадцать минут думал
       над вторым вопросом, печатала «потрачено 0 мин 1 с из 20 мин». */
    if (this.startedAt !== null) {
      const firstSkipped = this.answers.find(a => a.skipped);
      if (firstSkipped) firstSkipped.ms = Math.max(0, (this.startedAt + this.timerMs) - this.stepStartedAt);
    }
    this.stepIndex = this.sc.steps.length;
    this.finished = true;
  }

  score() {
    const acc = {}; TRAITS.forEach(t => acc[t] = { got: 0, max: 0, steps: 0 });
    for (const a of this.answers) {
      const max = a.sub.reduce((x, [, w]) => x + w, 0);
      acc[a.trait].got += max * a.share;
      acc[a.trait].max += max;
      acc[a.trait].steps++;
    }
    const traits = TRAITS.map(t => ({
      trait: t, steps: acc[t].steps,
      score: acc[t].max ? +(10 * acc[t].got / acc[t].max).toFixed(1) : null
    }));
    const scored = traits.filter(t => t.score !== null);
    const overall = scored.length ? +(scored.reduce((a, b) => a + b.score, 0) / scored.length).toFixed(1) : 0;
    return { traits, overall };
  }

  /**
   * СОГЛАСОВАННОСТЬ — то, чего нет ни у PrepMatter, ни в открытых разборах.
   * Q1 объявляет порядок кандидата; каждый последующий шаг помечен приоритетом,
   * которому он соответствует. Сильный ответ на шаге «своего» приоритета —
   * линия держится; сильные ответы только по приоритетам, объявленным низко, —
   * человек написал одно, а играет другое, и это ЧИСЛО, а не мнение.
   */
  consistency(lang) {
    const raw = this.answers[0] && Array.isArray(this.answers[0].choice) ? this.answers[0].choice : null;
    /* Негодное ранжирование (дубли, неполный набор, чужие id) всё равно шло сюда:
       rankShare ставил за него 0, а таблица строилась. Приоритеты, которых в ответе
       не было, получали declaredRank null, сортировка читала его как 9, а сравнение —
       как 0, то есть «объявлен первым»: два взаимоисключающих толкования одного null
       в шести строках. Кандидат видел столбец null и обвинение в непоследовательности
       по порядку, которого не объявлял. Порядка нет — метрики нет, и так и сказано. */
    const ids = this.sc.priorities.map(p => p.id);
    const valid = raw && raw.length === ids.length && new Set(raw).size === ids.length
                  && raw.every(x => ids.includes(x));
    if (!valid) return { declared: null, rows: [], driftPairs: 0, pairs: 0, alignment: null,
      note: L({ ru: 'Порядок приоритетов на первом шаге не был задан целиком, поэтому сравнивать игру не с чем.',
                en: 'The priority order was not fully declared on the first step, so there is nothing to compare the play against.' }, lang) };
    const declared = raw;
    const rank = Object.fromEntries(declared.map((id, i) => [id, i + 1]));   // 1 = объявлен первым
    const byP = {};
    for (const a of this.answers.slice(1)) {
      if (!a.priorityTag) continue;
      (byP[a.priorityTag] || (byP[a.priorityTag] = [])).push(a.share);
    }
    const rows = Object.entries(byP).map(([id, arr]) => ({
      priority: id,
      label: (this.sc.priorities.find(p => p.id === id) || {}).label || id,
      declaredRank: rank[id] ?? null,
      steps: arr.length,
      avgShare: +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)
    })).sort((a, b) => (a.declaredRank || 9) - (b.declaredRank || 9));
    // корреляция «объявил высоко ↔ играешь сильно»: чем меньше, тем сильнее расхождение
    /* Считаются только СРАВНИМЫЕ пары — те, где игра действительно различается.
       Равные доли (например ровная сильная игра по всем приоритетам) не являются
       расхождением: человек не противоречит себе тем, что везде сыграл одинаково.
       Без этой оговорки идеальная партия давала alignment 0 — дефект метрики,
       а не игрока. */
    const n = rows.length;
    let drift = 0, comparable = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      /* Сравнение шло по строгому неравенству, поэтому пара 0.10 против 0.20 весила
         столько же, сколько 1.00 против 0.10. Различие меньше шага шкалы долей
         различием не считается. */
      if (Math.abs(rows[i].avgShare - rows[j].avgShare) < 0.2) continue;
      comparable++;
      const declaredBetter = rows[i].declaredRank < rows[j].declaredRank;
      const playedBetter = rows[i].avgShare > rows[j].avgShare;
      if (declaredBetter !== playedBetter) drift++;
    }
    /* comparable === 0 возвращало alignment 1 — максимум согласованности выдавался
       тому, кто вообще не играл, и тому, кто ровно играл в пол. «Нет расхождений»
       и «нет свидетельств» — разные вещи, и метрика обязана их различать. */
    return { declared, rows, driftPairs: drift, pairs: comparable,
             alignment: comparable ? +(1 - drift / comparable).toFixed(2) : null,
             note: comparable ? null : L({ ru: 'Игра по всем приоритетам ровная — расхождению не на чем проявиться, поэтому числа нет.',
                                           en: 'Play is even across all priorities — a drift has nothing to show up against, so there is no number.' }, lang) };
  }

  /** разбор — только после конца, и он называет линию, а не сумму баллов */
  reveal(lang) {
    if (!this.finished) throw new Error('reveal before finish');
    const sc = this.score(), cons = this.consistency(lang);
    const weak = [...sc.traits].filter(t => t.score !== null).sort((a, b) => a.score - b.score).slice(0, 2);
    return {
      overall: sc.overall, traits: sc.traits, consistency: cons, weakest: weak,
      steps: this.answers.map((a, i) => {
        /* СИЛЬНЫЙ ХОД — то, ради чего это тренажёр, а не экзамен.
           У них разбор говорит только про твой ответ. Оценка без образца учит
           чувству вины, а не работе: человек знает, что сыграл на 20%, и не знает,
           как выглядит 100%. Показываем это ТОЛЬКО в разборе (в view его нет). */
        const st = this.sc.steps[i];
        let best = null;
        if (st.type === 'rank') {
          best = { text: st.key.map(id => (this.sc.priorities.find(p => p.id === id) || {}).label || id).join(' → '),
                   why: pickRu(st, 'why', lang) || null, mine: a.share >= 0.99 };
        } else {
          const set = st.variants ? (st.variants[a.variant] || st.variants[Object.keys(st.variants)[0]]).options : st.options;
          const b = set.find(o => o.share === 1.0);
          if (b) best = { text: b.text, why: b.fb, mine: a.choice === b.id };
        }
        return {
          n: a.n, trait: a.trait, choice: a.choice, share: a.share, skipped: !!a.skipped,
          sub: a.sub.map(([name, w]) => ({ name, got: +(w * a.share).toFixed(2), max: w })),
          feedback: a.skipped ? L({ ru: 'Шаг пропущен — 0 из возможного. Пропуск здесь считается ответом «не решил».',
                                    en: 'Step skipped — 0 out of the possible. A skip counts here as “did not solve”.' }, lang) : a.fb,
          best,
          ms: a.ms, variant: a.variant, priorityTag: a.priorityTag
        };
      }),
      skipped: this.answers.filter(a => a.skipped).length,
      usedMs: this.answers.reduce((a, b) => a + (b.ms || 0), 0)
    };
  }
}

module.exports = { SFLSession, TRAITS, SHARES, rankShare };
