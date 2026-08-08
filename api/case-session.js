// CasEdge case-session endpoint — server-side driver for the Full Case Interview
// mode backed by the 100-case library (api/_cases.json).
//
// Mirrors api/claude.js security posture: locked CORS, Supabase bearer token
// verification, shared per-user rate limit, body limits, upstream timeout and
// no error leakage. The case library and every answer key (interviewer_md,
// hint text, exhibit bodies) live ONLY on the server: the client receives the
// interviewer's reply plus a verdict and the list of revealed exhibit ids —
// never the answer key.
//
// Required Vercel env vars (same as api/claude.js):
//   ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, ALLOWED_ORIGIN (opt)
//
// The library file is loaded via require() (bundled into the function at build
// time); vercel.json also lists it under includeFiles as a belt-and-braces.

// Load the library via require so Vercel's bundler inlines it at build time.
// (Vercel transpiles this function to CommonJS, so ESM-only features like
// `import.meta.url` / `import fs` are unavailable — require is the safe path.)
const { verifyUserCached, rateLimitedScoped } = require('./_auth.js');
const CASES_DATA = require('./_cases.json');

const FALLBACK_ORIGIN = 'https://cas-edge-final.vercel.app';
const CASE_MODEL = 'claude-sonnet-5';   // fixed server-side; client cannot choose
// 2026-07-27. Прод-логи по двум подряд провалам на финальном синтезе:
//   stop_reason: max_tokens, blocks: ["thinking"]  — и на первом вызове, и на ретрае.
// То есть модель СЪЕДАЛА ВЕСЬ бюджет размышлением и не писала ни одного слова
// ответа. Кандидат отдал развёрнутую рекомендацию и получил «No response was
// returned» — дважды подряд, на самом важном шаге кейса.
// Чем длиннее транскрипт и чем труднее ход (синтез в конце — самый трудный),
// тем длиннее блок размышления. 2500 на это не хватало.
// Ориентир взят из соседнего пути: api/claude.js держит пол 5000 ровно по той
// же причине и на том же ходу не падает.
// Потолок + ЯВНЫЙ бюджет размышления. Без второго первый бесполезен: модель
// расширяет размышление до потолка, и счёт растёт вместе с ним. Кейс владельца
// 27.07 сжёг ~$0.39 при ориентире $0.12 — почти всё ушло в thinking-блоки,
// которые тарифицируются как выход.
// budget_tokens < max_tokens по контракту API; остаток гарантированно
// достаётся тексту ответа.
const MAX_TOKENS = 4000;
// budget_tokens этой моделью не поддерживается — см. MODES ниже.
const MAX_TOKENS_RETRY = 8000;

const MAX_BODY_BYTES = 200 * 1024;      // 200 KB request cap

/* ═══════════ ПОТОЛОК ЦЕНЫ КЕЙСА ═══════════════════════════════════════════
 * Владелец задал требование как потолок: кейс не должен стоить дороже $0.20
 * ни при каком поведении кандидата. Значит и решать надо потолком, а не
 * оптимизацией: оптимизация делает дешевле в среднем, потолок обязан держать
 * ХУДШИЙ случай.
 *
 * Закон, замеренный на живом проде 07.08 и заменивший прежний:
 *   · пока НАЧАЛО запроса не менялось  — прошлое читается из кеша (0.1x),
 *     пишется только прирост            ≈ $0.006 за ход
 *   · как только начало сдвинулось      — весь промпт пишется заново (1.25x)
 *                                        ≈ $0.020 за ход, в 3.3 раза дороже
 *
 * Прежняя редакция резала стенограмму до 3 800 токенов и двигала границу каждый
 * ход — то есть сама сдвигала начало на каждом ходе и платила по дорогой ветке
 * всю вторую половину партии. Управляем не размером промпта, а ЧАСТОТОЙ сдвига
 * начала: см. windowTranscript ниже.
 *
 * Почему это НЕ бьёт по качеству. До потолка память полная и не режется вовсе;
 * за потолком выбрасывается только середина, а рамка кейса и последние ходы
 * остаются дословно. Теряется способность сослаться на реплику из середины
 * очень длинной партии — цена настоящая, ограниченная и названная.
 */
const CASE_PRICE_CAP_USD = 0.20;

/* МЕТКА СБОРКИ. Отвечает на один вопрос: та ли это версия в проде.
   Значение — первые 12 знаков sha256 этого файла, посчитанного с самой этой
   строкой, приведённой к плейсхолдеру; вписывает и проверяет инструмент
   `06_Обмен/DEV/stamp_build.js`. Печатается в каждом ходе рядом с ценой.
   Куплено ошибкой смены 06.08: «залито или нет» решалось поиском по логам,
   поиск вернул пусто из-за отставания индексации, и вывод был неверным.
   Сравнение метки с диском от индексации логов не зависит. */
const BUILD = 'a6d9745ea92b';
const PRICE_IN_PER_MTOK = 2.0;
const PRICE_OUT_PER_MTOK = 10.0;
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.10;
const MAX_CANDIDATE_CHARS = 1500;   // одна реплика кандидата
const TOKENS_PER_CHAR = 0.27;       // латиница+кириллица вперемешку, замер по логам

const estTokens = (str) => Math.ceil(String(str || '').length * TOKENS_PER_CHAR);

/* Сколько кейс УЖЕ стоил — считается из самой стенограммы и номера шага.
 *
 * Сервер без состояния, и соблазн был попросить клиента присылать потраченное.
 * Нельзя: это значение, которым выгодно соврать. Но врать и не нужно —
 * стенограмма и есть свидетельство. Число ходов интервьюера равно числу
 * оплаченных вызовов, а `stepIndex` даёт, сколько из них были СМЕНОЙ шага.
 *
 * Считаем ровно по закону, замеренному на проде 06.08:
 *   смена шага — промпт пишется целиком (1.25x)
 *   повтор     — промпт читается (0.1x), пишется только прирост
 *
 * Первая версия этой функции считала ВСЕ ходы записями «оценка сверху безопаснее».
 * Гейт показал цену такой безопасности: обычная партия с одним повтором на шаг
 * закрывалась на пятнадцатом ходе, не дойдя до конца. Оценка сверху безопасна
 * для кошелька и небезопасна для кандидата — а его партия и есть продукт.
 * Точная оценка по замеренному закону не менее надёжна и никого не обрывает зря.
 */
function estimateSpentUsd(msgs, baseTokens, volatileTokens) {
  /* Считаем по закону, замеренному на проде 07.08 и переписанному после того,
     как изменчивый блок уехал в конец запроса:
       ход 1        — весь промпт пишется (1.25x)
       ход N > 1    — прошлый промпт читается из кеша (0.1x), пишется прирост
     Прежняя редакция делила ходы на «смены шага» и «повторы» и считала смену
     шага полной записью. После переноса изменчивого блока смена шага больше
     не рвёт кеш, и то деление врало в дорогую сторону — то есть закрывало
     нормальные партии раньше времени.
     Стенограмма и есть свидетельство: сервер без состояния, но число ходов
     и их размеры видны прямо в ней, и соврать ими кандидат не может. */
  const asst = msgs.filter(m => m.role === 'assistant');
  if (!asst.length) return 0;

  let usd = 0, prevPrompt = 0, running = 0;
  for (let i = 0; i < msgs.length; i++) {
    running += estTokens(msgs[i].content);
    if (msgs[i].role !== 'assistant') continue;
    const prompt = baseTokens + Math.min(running, TRANSCRIPT_CEILING_TOKENS);
    if (!prevPrompt) {
      usd += (prompt + (volatileTokens || 0)) * PRICE_IN_PER_MTOK * CACHE_WRITE_MULT;
    } else {
      usd += prevPrompt * PRICE_IN_PER_MTOK * CACHE_READ_MULT
           + (Math.max(0, prompt - prevPrompt) + (volatileTokens || 0))
             * PRICE_IN_PER_MTOK * CACHE_WRITE_MULT;
    }
    usd += estTokens(msgs[i].content) * PRICE_OUT_PER_MTOK;
    prevPrompt = prompt;
  }
  return usd / 1e6;
}


/* Окно стенограммы: ПАМЯТЬ ПОЛНАЯ, пока разговор не упрётся в потолок.
 *
 * Прежняя редакция резала стенограмму до 3 800 токенов и двигала границу
 * КАЖДЫЙ ход. Замер на живом проде 07.08 (кейс #2, четырнадцать ходов) показал,
 * во что это обходится:
 *
 *   ходы 1-8, стенограмма влезает целиком   cache_read растёт 0 → 6428   $0.0060 за ход
 *   ходы 9-14, началась обрезка             cache_read = 0 ВСЕГДА        $0.0199 за ход
 *
 * Кеш живёт только на НЕИЗМЕННОМ начале запроса. Сдвинули границу на одну
 * реплику - начало другое, и апстрим пишет весь промпт заново. То есть механизм,
 * написанный ради экономии токенов, включал режим, где каждый ход платит полную
 * запись: в 3.3 раза дороже. Мы резали память ради экономии и этим её теряли.
 *
 * Теперь два правила.
 *
 * ПЕРВОЕ: до потолка не режем ВООБЩЕ. Нормальная партия на 15-20 ходов доживает
 * до рекомендации с полной памятью, и стоит это дешевле прежней обрезки, потому
 * что каждый ход дописывает только прирост, а прошлое читает из кеша.
 *
 * ВТОРОЕ: упёрлись в потолок - режем ОДИН раз крупным блоком и держим границу
 * неподвижной, пока следующий блок не понадобится. Число выброшенных реплик
 * квантуется по BLOCK, поэтому оно не меняется от хода к ходу: префикс живёт
 * несколько ходов подряд, и кеш читается даже в обрезанном режиме.
 *
 * Сервер без состояния, поэтому граница обязана быть ФУНКЦИЕЙ стенограммы,
 * а не памятью о прошлом ходе: одна и та же стенограмма всегда даёт одну и ту же
 * границу, и два запроса подряд совпадают начало в начало.
 *
 * Цена этой правки названа честно: длинная партия держит в промпте больше
 * токенов, и промах кеша (кандидат думал дольше пяти минут) на ней дороже.
 * Замер: на двадцати ходах с промахом каждый четвёртый ход полная память
 * $0.264 против $0.240 у блочной обрезки - разница есть, но она меньше, чем
 * трёхкратная переплата, которую мы платили до сих пор.
 */
const TRANSCRIPT_CEILING_TOKENS = 12000;   // до этого не режем ничего
const TRANSCRIPT_FLOOR_TOKENS   = 8000;    // упёрлись - срезаем сразу до этого
const DROP_BLOCK = 8;                      // реплик в одном блоке выброса

function windowTranscript(msgs, ceilingTokens, floorTokens, block) {
  const CEIL = ceilingTokens || TRANSCRIPT_CEILING_TOKENS;
  const FLOOR = floorTokens || TRANSCRIPT_FLOOR_TOKENS;
  const BLOCK = block || DROP_BLOCK;
  if (!msgs.length) return { kept: msgs, dropped: 0 };
  const total = msgs.reduce((n, m) => n + estTokens(m.content), 0);
  if (total <= CEIL) return { kept: msgs, dropped: 0 };   // память полная

  // Сколько реплик надо выбросить, чтобы уйти под пол. Считаем с головы:
  // голова (рамка кейса) не выбрасывается никогда.
  const headTok = estTokens(msgs[0].content);
  let need = 0, running = total;
  for (let i = 1; i < msgs.length && running > FLOOR; i++) {
    running -= estTokens(msgs[i].content);
    need = i;
  }
  // Квантуем по блоку: граница стоит на месте, пока не понадобится следующий блок.
  let dropped = Math.min(Math.ceil(need / BLOCK) * BLOCK, msgs.length - 1);
  if (dropped <= 0) return { kept: msgs, dropped: 0 };

  const tail = msgs.slice(1 + dropped);
  const note = {
    role: 'user',
    content: `[Ранее в этом кейсе было ещё ${dropped} реплик - они опущены ради длины. Опирайся на рамку кейса выше и на последние ходы ниже; не делай вид, что разговор начался здесь.]`
  };
  void headTok;
  return { kept: [msgs[0], note, ...tail], dropped };
}

const RATE_LIMIT = 30;                  // requests per user per window
const RATE_WINDOW_MS = 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 60 * 1000;
const AUTH_TIMEOUT_MS = 8 * 1000;

/* ───────────────────────── case library (lazy, cached) ───────────────────── */
let _lib = null;
function lib() {
  if (_lib) return _lib;
  const data = CASES_DATA;
  const byId = new Map();
  for (const c of data.cases) byId.set(String(c.id), c);
  _lib = { data, byId };
  return _lib;
}

/* ───────────────────────── list action (meta only) ──────────────────────────
   Returns only non-spoiler meta. trap_or_clean and naive_error are the trap
   signal and the expected wrong answer — withheld so the candidate cannot see
   the twist before starting. Answer keys, prompts and exhibits are omitted. */
export function listCases() {
  const { data } = lib();
  // тот же фильтр, что и в автоподборе: Easy не показываем и в ручном списке
  return data.cases.filter(isServable).map(c => ({
    id: c.id,
    title: c.title,
    case_type: c.case_type,
    industry: c.industry,
    difficulty: c.difficulty,
    est_minutes: c.est_minutes,
    steps: Array.isArray(c.steps) ? c.steps.length : 0
  }));
}

/* ───────────────────────── adaptive auto-pick ────────────────────────────────
   The client sends only firm + caseType + the candidate's rolling level + the
   ids already seen. The server picks ONE unseen case whose difficulty matches
   the level, widening to neighbouring bands if the target band is exhausted. */
function normDiff(d) { return (d || '').replace(/\*/g, '').trim(); }

function typeMatchServer(libType, chosen) {
  const a = (libType || '').toLowerCase();
  const b = (chosen || '').toLowerCase();
  if (!b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const syn = {
    'profitability': ['profit', 'margin', 'turnaround'],
    'market entry': ['entry', 'market sizing', 'go-to-market'],
    'm&a': ['merger', 'acquisition', 'due diligence', 'bolt-on', 'sell-side'],
    'growth strategy': ['growth', 'revenue', 'expansion'],
    'cost reduction': ['cost', 'operations', 'efficiency'],
    'pricing': ['price', 'monetization']
  };
  return (syn[b] || []).some(s => a.includes(s));
}

// 2026-07-26, решение владельца: Easy из выдачи убран целиком. 39 кейсов этого
// тира (26 Easy·LIGHT + 13 Easy·STANDARD) не тянут планку BCG — пять шагов,
// один экзибит, ловушка в один ход. Цех поднимает их до Medium; до тех пор
// движок их просто не выдаёт. Данные не трогаются: кейсы на месте, помечены
// Easy и остаются недоступны, пока плашка не сменится.
const SERVED_BANDS = ['Medium', 'Hard'];

/* 2026-08-07: КЕЙС НА ПЕРЕСБОРКЕ НЕ ВЫДАЁТСЯ.
   Повод — #230 «Latte Than You Think». Цех снял его с Clean, потому что число
   в ключе посчитано на неверной базе, и оставил в теле пометку «ВЕДУЩЕМУ: не
   засчитывать ответ по напечатанному числу». Пометка адресована человеку,
   которого нет: ведущий здесь — модель, и `interviewer_md` уходит ей как ANSWER
   KEY. То есть кандидат, давший ВЕРНЫЙ ответ, получал «неверно» по ключу,
   который сам цех объявил сломанным.
   Отсюда правило движка, а не данных: пока кейс на пересборке, он не попадает
   ни в список, ни в автоподбор. Признак — явное поле `status`, а страховкой
   разбирается зачин `qa_checks_md`: пометка уже написана словами, и полагаться
   только на поле, которого в старых телах нет, значит оставить дыру открытой. */
const HOLD_STATUS = new Set(['rebuild', 'hold', 'wip', 'пересборка']);
// без \b: в JS-регексе кириллица не является \w, и граница слова после «Е»
// не срабатывает — пометка «НА ПЕРЕСБОРКЕ.» проходила бы мимо фильтра.
// Поймано мутацией гейта, а не чтением.
const HOLD_RE = /^\s*(?:⚠️\s*)?(?:НА\s+ПЕРЕСБОРКЕ|ON\s+REBUILD)/i;
export function isServable(c) {
  if (!c) return false;
  if (c.status && HOLD_STATUS.has(String(c.status).toLowerCase())) return false;
  if (typeof c.qa_checks_md === 'string' && HOLD_RE.test(c.qa_checks_md)) return false;
  return SERVED_BANDS.includes(normDiff(c.difficulty));
}

export function levelToBand(level) {
  const n = Number(level);
  if (!Number.isFinite(n)) return 'Medium';   // no history yet → start in the middle
  if (n < 7.5) return 'Medium';               // нижний обслуживаемый тир — Medium, не Easy
  return 'Hard';
}

const BAND_FALLBACK = {
  Medium: ['Medium', 'Hard'],
  Hard: ['Hard', 'Medium']
};

function pickMeta(c) {
  return {
    id: c.id, title: c.title, case_type: c.case_type, industry: c.industry,
    difficulty: normDiff(c.difficulty), est_minutes: c.est_minutes,
    steps: Array.isArray(c.steps) ? c.steps.length : 0
  };
}

export function pickCase({ caseType, level, seenIds, rand }) {
  const { data } = lib();
  const seen = new Set((Array.isArray(seenIds) ? seenIds : []).map(Number));
  const r = typeof rand === 'number' ? rand : 0.5;   // deterministic unless caller passes Math.random()
  // Easy отфильтрован на входе в пул, а не только в переборе бэндов: иначе
  // последний фолбэк (строка ниже, «взять что угодно из пула») всё равно
  // мог бы выдать Easy-кейс.
  const pool = data.cases.filter(c => typeMatchServer(c.case_type, caseType)
    && !seen.has(Number(c.id))
    && isServable(c));
  if (!pool.length) {
    const anyUnseen = data.cases.some(c => !seen.has(Number(c.id)) && isServable(c));
    return { exhausted: true, scope: anyUnseen ? 'type' : 'all' };
  }
  const band = levelToBand(level);
  for (const b of (BAND_FALLBACK[band] || SERVED_BANDS)) {
    const cands = pool.filter(c => normDiff(c.difficulty) === b);
    if (cands.length) {
      return { case: pickMeta(cands[Math.floor(r * cands.length) % cands.length]), band: b, targetBand: band };
    }
  }
  return { case: pickMeta(pool[Math.floor(r * pool.length) % pool.length]), band: 'Medium', targetBand: band };
}

/* ───────────────────────── marker parsing ────────────────────────────────────
   The interviewer is told to append hidden markers. We strip them from the
   text the client sees and surface them structurally. */

/* ─────────── две правки, снятые с цехов, чтобы не переписывали данные ─────────
   1) safeLabel(): `step.label` уходит в промпт интервьюера (меню шагов и «CURRENT
      STEP»). У ~85 шагов метка называет шаг наивным — «Наивный расчёт»,
      «🔻 NAIVE — …», «Naive scenario». Модель видит это и может произнести:
      кандидат узнаёт, что шаг ловушечный, до того как начал считать. Чистить
      надо здесь, а не переименовывать 85 меток в данных: метка несёт модели
      смысл шага, а вырезать надо ровно спойлер.
   2) stepLangNote(): язык объявлен на КЕЙС, а он бывает разный по ШАГАМ — 24
      кейса с английским промптом и частью русских вопросов. При lang:'en' модель
      процитирует русский вопрос англофону, без флага — перескажет английские и
      потеряет формулировку. Обе ветки плохие. Решаем по факту: у каждого шага
      смотрим язык его собственного `candidate_md` и говорим модели, что с ним
      делать. Это снимает перевод 24 кейсов. */
// 01.08.2026. Тут было /naive|наивн/i, и оно пропускало три класса разом.
// Найдено замером по мастеру, а не чтением:
//   · «наив» без «н» — 4 метки («Наив», «[HU] …чтобы наив был прав»). Тот же
//     класс, на котором я уже горел в safeProduces: узкая форма слова.
//   · CORRECT / ВЕРНО — 35 меток («CORRECT: сегментированное повышение»). Метка
//     едет модели в меню шагов ilead (стр. ~482) и называет ответ до счёта.
//   · [MM] [HU] [OD] [CB] — 97 меток. Это служебные коды реестра. Спойлером они
//     не являются, но при пустом candidate_md уезжают кандидату ВМЕСТО вопроса.
//     Просил цех кейсов, и он прав: одна строка закрывает прошлое и будущее.
// Границы слова — по Unicode: в JS  это ASCII и на кириллице не работает.
const LABEL_MARKER = /^\s*\[(?:MM|HU|OD|OD-lite|CB)\]\s*/iu;
// `верн[\p{L}]*` ловило и ГЛАГОЛ: «вернуть цены», «вернулись», «вернётся».
// Нашёл цех кейсов — 12 ложных из 18 на своей стороне. В МЕТКАХ сегодня
// глагольных форм ноль (все 57 — именные), так что на моей стороне правка
// ничего не меняет; она нужна на будущее: метка «Вернуть цены» появится
// однажды, и краснеть она не должна. Именные формы перечислены явно.
const LABEL_SPOILER = /(?<![\p{L}\p{N}_])(?:наив[\p{L}]*|naive|correct|верн(?:ый|ая|ое|ые|ого|ому|ым|ыми|ых|ом|ой|ую|о))(?![\p{L}\p{N}])/iu;
// Метка вида «CORRECT: сегментированное повышение» не чинится вырезанием слова:
// остаток И ЕСТЬ ответ. Такая метка целиком заменяется нейтральной.
const LABEL_VERDICT = /^\s*(?:CORRECT|ВЕРНО)\b\s*[:—–-]?/iu;

/* 3) safeProduces(): `step.produces` едет модели ДВАЖДЫ и оба раза в блоках,
      которые она пересказывает вслух — «ALREADY ESTABLISHED» после закрытия шага
      и «(yields: …)» в меню доступных. У 45 шагов в 34 кейсах там стоит
      внутренний код реестра: «наив #7. Удержание логотипов считает клиентов»,
      «наив -> расширять», «naive annual $296M». Поймано живым прогоном #165:
      интервьюер сказал кандидату «Это ровно "наивность #7"» — код нашей
      бухгалтерии в лицо кандидату, плюс подсказка, что ловушка каталогизирована
      заранее. Метку чистит safeLabel, а это поле шло сырым.
      Режем только номерную ссылку и слово-маркер; сам результат шага сохраняем -
      он нужен модели, чтобы не переспрашивать уже установленное. */
// Границы слова считаем по Unicode, а не через \\b: в JS \\b — ASCII, и /\\bнаив/
// НЕ совпадает с кириллицей. Первая редакция этой правки молча пропускала ровно
// тот случай, ради которого писалась. Lookbehind заодно бережёт составные
// идентификаторы вроде `build_naive` — там это имя переменной, а не спойлер.
const PRODUCES_TAG = /(?<![\p{L}\p{N}_])(?:наив[\p{L}]*|naive)(?![\p{L}\p{N}])\s*[#№]?\s*\d*\s*(?:->|[.:—–-])?\s*/giu;
const PRODUCES_SPOILER = /(?<![\p{L}\p{N}_])(?:наив|naive)/iu;
function safeProduces(s) {
  const raw = String(s == null ? '' : s);
  if (!PRODUCES_SPOILER.test(raw)) return raw;
  const cleaned = raw
    .replace(PRODUCES_TAG, '')
    .replace(/^\s*(?:—|–|-|;|,|\.|:|и\s|and\s|это\s|the\s)+/iu, '')
    .replace(/\s*;\s*;\s*/g, '; ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned || 'результат шага установлен';
}
function safeLabel(label) {
  let t = String(label || '').replace(/^[#\s\p{Emoji_Presentation}\p{So}*_]+/u, '').replace(LABEL_MARKER, '').trim();
  const tailOf = x => (x.match(/\((?:[^()]*\bmin\b[^()]*)\)\s*$/i) || [''])[0];
  if (LABEL_VERDICT.test(t)) {
    const tl = tailOf(t);
    return ('Analysis' + (tl ? ' ' + tl : '')).trim();
  }
  if (!LABEL_SPOILER.test(t)) return t;
  // Метку режем по разделителям и выбрасываем куски со спойлером. Хвост в
  // скобках («(4 min)») сохраняем — он несёт тайминг, а не подсказку.
  const tail = (t.match(/\((?:[^()]*\bmin\b[^()]*)\)\s*$/i) || [''])[0];
  const kept = t.replace(/\((?:[^()]*\bmin\b[^()]*)\)\s*$/i, '')
    .split(/\s*(?:—|–|-{1,2}|·|:|\|)\s*/)
    .filter(part => part.trim() && !LABEL_SPOILER.test(part))
    .join(' — ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return ((kept || 'Analysis') + (tail ? ' ' + tail : '')).trim();
}
const HAS_CYR = /[а-яА-ЯёЁ]/;
function stepLangNote(md) {
  const t = String(md || '');
  if (!t.trim()) return '';
  return HAS_CYR.test(t)
    ? '\n[LANGUAGE: this question is written in Russian source — ask it in natural English, keeping every number, unit and proper name exactly.]'
    : '\n[LANGUAGE: this question is already in English — ask it VERBATIM, do not rephrase.]';
}

/* ─────────────────────── ПОТОК: фильтр маркеров ──────────────────────────────
   Замер на живом проде 01.08: открывающий ход 6.8–7.8 с, оценочный 4.9 с,
   и TTFB РАВЕН общему времени — то есть кандидат сидит перед пустым экраном
   ровно столько, сколько модель пишет. Стриминг не трогает ни промпт, ни модель,
   ни max_tokens: те же самые токены, только отданные по мере появления.
   Качество измениться не может — меняется момент доставки, а не содержание.

   Одна сложность: текст модели несёт служебные маркеры <verdict> <reveal> <step>,
   и парсит их СЕРВЕР (parseMarkers). Дублировать разбор в клиенте нельзя — это
   C24, две копии одной логики. Поэтому маркеры снимаются здесь, на лету, и
   наружу уходит только чистая проза.

   Правило удержания: если хвост буфера может оказаться НАЧАЛОМ маркера
   («<», «<ver», «<reveal>ex»), он придерживается до следующего куска. Иначе
   кандидат увидел бы «<ver» и через секунду его исчезновение. Придержанное
   отдаётся, как только стало ясно, что это не маркер, либо в конце потока. */
const MARKER_OPEN = /<(?:verdict|reveal|step)>/i;
const MARKER_FULL = /<(verdict|reveal|step)>[\s\S]*?<\/\1>/gi;
// «Может ли этот хвост стать маркером» — префикс любого из открывающих тегов.
const TAG_PREFIX = /<(?:v(?:e(?:r(?:d(?:i(?:c(?:t)?)?)?)?)?)?|r(?:e(?:v(?:e(?:a(?:l)?)?)?)?)?|s(?:t(?:e(?:p)?)?)?)?$/i;
export function createMarkerFilter() {
  let buf = '';
  return {
    /** отдаёт безопасный кусок текста, придерживая возможный недописанный маркер */
    push(chunk) {
      buf += chunk;
      // снимаем все ЗАКРЫТЫЕ маркеры целиком
      buf = buf.replace(MARKER_FULL, '');
      // если внутри остался НЕзакрытый маркер — держим всё от него и дальше
      const open = buf.search(MARKER_OPEN);
      if (open >= 0) { const out = buf.slice(0, open); buf = buf.slice(open); return out; }
      // держим хвост, который может оказаться началом тега
      const m = buf.match(TAG_PREFIX);
      if (m && m.index !== undefined) { const out = buf.slice(0, m.index); buf = buf.slice(m.index); return out; }
      const out = buf; buf = ''; return out;
    },
    /* Конец потока. Придержанный хвост может быть: закрытым маркером (снять),
       открытым без закрывающего (снять вместе с содержимым до конца) или
       НЕДОПИСАННЫМ префиксом «<verdi» (тоже снять — модель оборвалась на теге,
       и показывать кандидату огрызок тега нельзя).
       Первая редакция снимала только первые два случая, и тест «маркер
       обрывается в конце потока» выдавал кандидату «Text <verdi». */
    flush() {
      let out = buf.replace(MARKER_FULL, '');
      const open = out.search(MARKER_OPEN);
      if (open >= 0) out = out.slice(0, open);
      const m = out.match(TAG_PREFIX);
      if (m && m.index !== undefined) out = out.slice(0, m.index);
      buf = '';
      return out;
    }
  };
}

/* ЧУЖИЕ ЧИСЛА В ПЕРВОЙ ПОДСКАЗКЕ.
 *
 * Замер на живом проде 08.08, кейс #161, три прогона подряд: правило «на первой
 * попытке не называть числа, которых кандидат не писал» соблюдено ОДИН раз из
 * трёх. Дважды модель спросила «what happens to the $6,256,477 allocated to that
 * line» — то есть показала пальцем на нужную строку и назвала величину из ключа
 * шага, которого кандидат не проходил.
 *
 * Запрет в промпте есть и он проигрывает: ключ с числом лежит в том же контексте,
 * а «задай один короткий вопрос» проще всего исполнить, ткнув в строку. Поэтому
 * правило переносится из текста в код: ответ первой ступени ПРОВЕРЯЕТСЯ, и если
 * в нём есть величина, которой нет в реплике кандидата, ход переписывается.
 *
 * Что считается величиной: число из двух и более значащих цифр. Однозначные
 * («one», «3 lines», «two levers») ничего не выдают и сравнивать их — плодить
 * ложные срабатывания. Разделители разрядов и валюта снимаются, чтобы
 * «$6,256,477» и «6256477» были одним числом.
 */
export function foreignFigures(reply, candidateText) {
  const grab = (t) => {
    const out = new Set();
    const re = /\d[\d.,\s\u00a0]*/g;
    let m;
    while ((m = re.exec(String(t || ''))) !== null) {
      const raw = m[0].replace(/[\s\u00a0,]/g, '').replace(/\.$/, '');
      if (!raw) continue;
      const digits = raw.replace(/[^0-9]/g, '');
      if (digits.replace(/^0+/, '').length < 2) continue;   // однозначные не считаем
      out.add(String(parseFloat(raw)));
      out.add(digits.replace(/^0+/, ''));                    // 6256477 и 6,256,477 — одно
    }
    return out;
  };
  const mine = grab(candidateText);
  const theirs = grab(reply);
  const bad = [];
  for (const v of theirs) if (!mine.has(v)) bad.push(v);
  return bad;
}

export function parseMarkers(text, priorRevealed) {
  const revealed = new Set(priorRevealed || []);
  let verdict = null;

  const vMatch = text.match(/<verdict>\s*(pass|retry)\s*<\/verdict>/i);
  if (vMatch) verdict = vMatch[1].toLowerCase();

  const revRe = /<reveal>\s*([a-zA-Z0-9_-]+)\s*<\/reveal>/gi;
  let m;
  while ((m = revRe.exec(text)) !== null) revealed.add(m[1]);

  // Interviewee-led mode only: <step>N</step> markers name which step(s) the
  // candidate just completed, so the client can mark them done and unlock
  // dependents. Ignored/absent in linear mode.
  const completedSteps = [];
  const stepRe = /<step>\s*(\d+)\s*<\/step>/gi;
  while ((m = stepRe.exec(text)) !== null) { const n = Number(m[1]); if (!completedSteps.includes(n)) completedSteps.push(n); }

  // Remove every marker from the visible reply.
  const reply = text
    .replace(/<verdict>[\s\S]*?<\/verdict>/gi, '')
    .replace(/<reveal>[\s\S]*?<\/reveal>/gi, '')
    .replace(/<step>[\s\S]*?<\/step>/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { reply, verdict, revealedExhibits: Array.from(revealed), completedSteps };
}

/* ───────────────────────── exhibit gating ────────────────────────────────────
   Two gating sources, computed once per case (not per step) so a trap exhibit
   stays hidden across the WHOLE case until the candidate earns it:
     • exhibit.reveal === 'on_request'         → gated, triggers from exhibit.triggers
     • any step.conditional_exhibits[].title   → the disclosure layer (#81+):
       matches a case exhibit by title and gates it with that step's triggers.
   A matched/on_request exhibit is included with its body but wrapped in a strict
   gate: the interviewer surfaces it ONLY when the candidate asks about the
   triggers, prefixing the reply with <reveal>id</reveal>. Once the client reports
   the id as revealed it is shown ungated. Conditional topics that match no case
   exhibit become a lightweight "do not volunteer unless asked" instruction. */
function titleMatch(a, b) {
  a = (a || '').trim().toLowerCase().replace(/[.\s]+$/, '');
  b = (b || '').trim().toLowerCase().replace(/[.\s]+$/, '');
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

// Map<exhibitId, Set<trigger>> plus unmatched conditional topics [{title,triggers}]
function caseGates(caseObj) {
  const exhibits = Array.isArray(caseObj.exhibits) ? caseObj.exhibits : [];
  const gateMap = new Map();
  const addGate = (id, triggers) => {
    if (!gateMap.has(id)) gateMap.set(id, new Set());
    for (const t of (triggers || [])) if (t) gateMap.get(id).add(t);
  };
  for (const ex of exhibits) {
    if (ex.reveal === 'on_request') addGate(ex.id, ex.triggers || []);
  }
  const unmatchedTopics = [];
  for (const s of (caseObj.steps || [])) {
    for (const ce of (s.conditional_exhibits || [])) {
      const hit = exhibits.find(ex => titleMatch(ex.title, ce.title));
      if (hit) addGate(hit.id, ce.triggers || []);
      else unmatchedTopics.push({ title: (ce.title || '').trim(), triggers: ce.triggers || [] });
    }
  }
  return { gateMap, unmatchedTopics };
}

// Returns { stableText, volatileText }. Auto (never-gated) exhibits are STABLE
// (identical every turn → cacheable). Gated/revealed exhibits and gated topics
// go in VOLATILE (they depend on revealedSet, which changes mid-case), so the
// cached prefix stays byte-identical across the whole case.
function exhibitsBlock(caseObj, revealedSet) {
  const exhibits = Array.isArray(caseObj.exhibits) ? caseObj.exhibits : [];
  const { gateMap, unmatchedTopics } = caseGates(caseObj);
  const stableShown = [];
  const volatile = [];
  for (const ex of exhibits) {
    const gate = gateMap.get(ex.id);
    // Exhibits with a `render` payload are drawn by the app as a visual card
    // (chart/table) the moment they are revealed — the model must not retype
    // the full data in prose.
    const renderNote = ex.render
      ? `\nThis exhibit is DISPLAYED TO THE CANDIDATE AS A VISUAL CHART/TABLE by the app when revealed. Do NOT retype its rows/numbers in your reply — introduce it in one short sentence (e.g. "Here's the data — what do you take away?") and let the visual speak. You may quote individual numbers later when discussing their analysis.`
      : '';
    if (!gate) {
      stableShown.push(`EXHIBIT id="${ex.id}" — "${ex.title}" (available to share):\n${ex.body_md || ''}`);
    } else if (revealedSet.has(ex.id)) {
      volatile.push(`EXHIBIT id="${ex.id}" — "${ex.title}" (revealed — already shown to the candidate${ex.render ? ' as a visual card' : ''}; refer to it, do not retype it):\n${ex.body_md || ''}`);
    } else {
      const triggers = Array.from(gate);
      volatile.push(
        `HIDDEN EXHIBIT id="${ex.id}" — "${ex.title}"\n` +
        `Do NOT mention or describe this exhibit's contents unless the candidate explicitly asks about: ` +
        `${triggers.length ? triggers.map(t => `"${t}"`).join(', ') : 'the specific data it contains'}.\n` +
        `If (and only if) they ask, BEGIN your reply with the marker <reveal>${ex.id}</reveal> and then present it.\n` +
        `Exception (no deadlock): if the CURRENT STEP cannot be answered without this exhibit and the candidate has already made an attempt without asking for it, you may introduce it yourself — still beginning with <reveal>${ex.id}</reveal>.${renderNote}\n` +
        `Contents (keep hidden until asked):\n${ex.body_md || ''}`
      );
    }
  }
  let stableText = '';
  if (stableShown.length) stableText += `\n\n════ EXHIBITS (share when the candidate reaches them) ════\n${stableShown.join('\n\n')}`;
  let volatileText = '';
  if (volatile.length) volatileText += `\n\n════ GATED / REVEALED EXHIBITS ════\n${volatile.join('\n\n')}`;
  if (unmatchedTopics.length) {
    const lines = unmatchedTopics.map(u =>
      `- "${u.title}": do not volunteer anything about this unless the candidate explicitly asks about ${
        (u.triggers || []).length ? u.triggers.map(t => `"${t}"`).join(', ') : 'it'}.`);
    volatileText += `\n\n════ GATED TOPICS (do not volunteer; only if asked) ════\n${lines.join('\n')}`;
  }
  return { stableText, volatileText };
}

/* ───────────────────────── firm style ────────────────────────────────────── */
function firmStyle(firm) {
  const f = (firm || '').toLowerCase();
  if (f.includes('mckinsey'))
    return 'McKinsey — INTERVIEWER-LED. You drive the case. Walk the candidate through the steps in order, asking each step\'s question yourself and steering direction. The candidate follows and suggests next moves; you decide when to advance. Hypothesis-driven, structured before each bucket.';
  if (f.includes('bcg'))
    return 'BCG — INTERVIEWEE-LED. The candidate drives; you follow and respond to their requests. Still guide them through this case\'s fixed steps, but let them lead the direction and reach each question naturally. A final recommendation is always required at the end.';
  if (f.includes('bain'))
    return 'Bain — candidate-led and conversational. Reward creativity and the "airport test". Guide through the fixed steps while letting the candidate drive.';
  return 'MBB interviewer. Guide the candidate through the fixed steps, balancing structure with letting them drive.';
}

/* ───────────────────────── hint gating ───────────────────────────────────────
   attemptCount is the number of failed attempts on the CURRENT step.
   0  → L0 silence: no hints, no leading.
   >=2 with L1 → L1 nudge allowed.
   >=3 with L2 → L2 nudge allowed. */
/* 2026-08-07. ЗАМЕР НА ЖИВОМ ПРОДЕ, ТРИ КЕЙСА ДО КОНЦА.
   В кейсе #161 кандидат дал наивный ответ ПЕРВОЙ попыткой (attemptCount = 0,
   то есть L0 — «не подсказывать вовсе»). Ответ движка:

     «That's the naive move. ...of that −$1.93M, which costs actually disappear
      if the line shuts, and which just get reallocated elsewhere? Rework the
      closure logic on a contribution basis, not a fully-costed one.»

   Это не подсказка, это РЕШЕНИЕ: названы и наличие ловушки, и механизм
   (делить затраты на исчезающие и переносимые), и метод (контрибуция).
   Кандидату осталась арифметика — а предмет кейса был именно в том, чтобы
   додуматься до этого деления самому.

   Причина не в тексте L0, он был верным. Причина в ПРОТИВОРЕЧИИ: блок сценария
   ниже требовал «a short, demanding nudge toward the right MOVE», а «nudge
   toward the MOVE» буквально означает «назови ход». Общий запрет проигрывает
   конкретному указанию — тот же класс, на котором горел кейс #230.

   Лечение — лестница, у которой первая ступень НЕ СОДЕРЖИТ ХОДА:
     попытка 1  вопрос, возвращающий кандидата к его же допущению. Ни ловушки,
                ни механизма, ни метода, ни имени статьи
     попытка 2  узкое направление: КУДА смотреть, но не ЧТО там увидеть
     попытка 3  механизм целиком — и это уже видно в стенограмме, а значит
                в оценке
   Плюс кандидат может попросить подсказку сам; тогда она даётся сразу, и просьба
   остаётся в стенограмме, которую читает разбор. Темп выбирает кандидат,
   планка не двигается. */
/* Без \b вокруг кириллицы: в JS кириллица не является \w, и граница слова
   не срабатывает — «нужна подсказка» проходила мимо. Тот же класс поймал гейт
   снятия кейса с выдачи тремя часами раньше.
   И просьба обязана быть ОТ ПЕРВОГО ЛИЦА: «Revenue is stuck at the same level» —
   это описание рынка, а не крик о помощи. Ловушка поймана мутацией гейта. */
const HINT_REQUEST_RE = new RegExp([
  "\\b(?:i|we)(?:'m|'re| am| are)? ?(?:really |a bit |completely )?stuck\\b",
  "\\b(?:can i (?:get|have)|could i (?:get|have)|give me|any chance of) a (?:hint|clue|steer|nudge|pointer)\\b",
  "\\b(?:i need|need) (?:a )?(?:hint|help|steer|pointer)\\b",
  "\\bhelp me out\\b|\\bpoint me\\b|\\bi(?:'m| am) lost\\b",
  "(?:нужна|дай|дайте|можно) (?:мне )?(?:подсказ|намёк|намек|помощ)",
  "(?:я |мы )?застрял|не понимаю, куда|подскаж"
].join('|'), 'i');
export function candidateAskedForHint(msgs) {
  for (let i = msgs.length - 1; i >= 0 && i >= msgs.length - 2; i--) {
    const m = msgs[i];
    if (m && m.role === 'user' && typeof m.content === 'string' && HINT_REQUEST_RE.test(m.content)) return true;
  }
  return false;
}

const NEVER_SAY = `
Never do ANY of the following, at any attempt level:
- name or hint at the existence of a trap, twist, catch, or "naive" reading;
- name the mechanism, the method, or the line item the candidate has missed;
- state or restate the machinery of the case: step numbers, step names, how many
  steps remain, or a menu of named future analyses. The candidate is in an
  interview, not a workflow;
- credit the candidate with anything they did not actually say. If it is not in
  their own words in this transcript, it did not happen.`;

function hintsBlock(step, attemptCount, asked) {
  const h = (step && step.hints) || {};
  const n = Number(attemptCount) || 0;

  if (n <= 0 && !asked) {
    /* 2026-08-08, замер на проде после первой правки. Лестница заработала —
       ушли и «That's the naive move», и название метода, и весь механизм, —
       но на первой ступени модель ТРИ РАЗА ИЗ ТРЁХ показывала пальцем на нужную
       строку: «what happens to that $6,256,477 of allocated fixed cost».
       Запрет «не называть строку» есть в NEVER_SAY и проигрывает, потому что он
       про вкус, а ключ с числом лежит рядом. Поэтому правило переписано в
       МЕХАНИЧЕСКОЕ: на первой попытке нельзя произносить ни одного числа и ни
       одного названия статьи, которых нет в собственной реплике кандидата.
       Такое правило нельзя истолковать в свою пользу, и его видно гейтом. */
    return `\n\nHINT POLICY — ATTEMPT 1. Give NO hint. If the answer is wrong, reply with ONE
short question and then stop. HARD CONSTRAINT on that question, and it overrides
every instinct to be helpful:

  · it may NOT contain any figure that the candidate did not write themselves;
  · it may NOT name the line item, cost category, row or exhibit they missed;
  · it may only point back at THEIR OWN claim and ask what it assumes.

If you cannot ask it without citing the thing they missed, ask a shorter and
vaguer question. Vague is correct here: the candidate is supposed to go looking.
Good: "What would actually change at the plant if that line stopped?"
Good: "You said the loss goes away. What has to be true for that to hold?"
Bad:  "What happens to that $6,256,477 of allocated fixed cost?" — you just told
      them the row and the number, which is the whole answer.${NEVER_SAY}`;
  }

  if (asked && n <= 0) {
    return `\n\nHINT POLICY — THE CANDIDATE ASKED FOR A HINT. Give the Level-1 steer${h.L1 ? `: ${h.L1}` : ''}
— point at WHERE to look, not at what they will find there. One or two sentences,
then stop and let them work.${NEVER_SAY}`;
  }

  if (n === 1) {
    return `\n\nHINT POLICY — ATTEMPT 2. A narrow directional steer is now allowed${h.L1 ? `: ${h.L1}` : ''}.
Point at WHERE to look — an exhibit, a row, a quantity they have not questioned —
never at what they will find there. One or two sentences, then stop.${NEVER_SAY}`;
  }

  const lines = [];
  if (h.L1) lines.push(`Level-1 steer: ${h.L1}`);
  if (h.L2) lines.push(`Level-2 steer: ${h.L2}`);
  return `\n\nHINT POLICY — ATTEMPT ${n + 1}. They have missed this ${n} times. You may now give the
mechanism itself, plainly, and then ask them to redo the calculation with it.${
  lines.length ? '\nUse:\n- ' + lines.join('\n- ') : ''}
Do not soften it and do not pretend they nearly had it.${NEVER_SAY}`;
}

/* ───────────────────────── weakness focus ────────────────────────────────────
   The client sends the candidate's weakest dimension (computed from THEIR own
   score history). Server maps the key to grading emphasis — a whitelist, so
   nothing user-controlled ever reaches the prompt as free text. */
const FOCUS_GUIDE = {
  structure: 'STRUCTURE (MECE). Their frameworks tend to be loose. Hold the bar high: demand a hypothesis stated first, ≥3 genuinely MECE buckets tailored to THIS case, and a clear starting point. If the structure is generic or overlapping, retry with a nudge naming exactly what is not MECE.',
  quant: 'QUANTITATIVE ACCURACY. They slip on math. Make them state the approach before computing, show every step, and sanity-check units. Any arithmetic slip or hand-waved "roughly" where an exact number exists → retry and ask for the actual calculation.',
  logic: 'BUSINESS JUDGMENT. They stop at surface answers. Push for the "so what": every number must be tied to a business implication and a non-obvious driver. If they state facts without an insight, retry asking what it MEANS for the client.',
  comm: 'COMMUNICATION (answer-first / Minto). They tend to build up to conclusions instead of leading with them. Any answer that buries the conclusion at the end, uses filler, or hedges → retry with a demand to restate it conclusion-FIRST in one crisp sentence.',
  ownership: 'CASE OWNERSHIP. They tend to wait to be led. Reward sharp, specific data requests and self-driven next steps; if they stall or ask you to steer, retry and make them propose the next move themselves.'
};
export function focusBlock(focusKey) {
  const g = FOCUS_GUIDE[focusKey];
  if (!g) return '';
  return `\n\n════ CANDIDATE FOCUS AREA (from their own score history — never mention this to them) ════
This candidate's weakest dimension is: ${g}
Apply this as EXTRA strictness on top of the step's normal pass criteria — the step key still decides content; this decides how demanding you are about HOW they deliver it.`;
}

/* ───────────────────────── dependency graph (interviewee-led) ────────────────
   A case is "graph-ready" once its steps carry depends_on tags (added by the
   authoring pipeline). Only then, and only for candidate-led firms (BCG/Bain),
   the engine runs interviewee-led: steps are unlockable NODES, not a queue. */
export function caseIsGraphReady(steps) {
  return Array.isArray(steps) && steps.some(s => s && Array.isArray(s.depends_on));
}
export function firmIsCandidateLed(firm) {
  const f = (firm || '').toLowerCase();
  return f.includes('bcg') || f.includes('bain');
}
// step numbers not yet done whose every depends_on is already done
export function unlockedStepNums(steps, doneSet) {
  const done = doneSet instanceof Set ? doneSet : new Set(doneSet || []);
  const out = [];
  for (const s of (steps || [])) {
    const n = s.step;
    if (done.has(n)) continue;
    const deps = Array.isArray(s.depends_on) ? s.depends_on : [];
    if (deps.every(d => done.has(d))) out.push(n);
  }
  return out;
}

/* Interviewee-led system prompt. Same STABLE block as linear (cacheable case
   body), but the VOLATILE block presents the SET of currently-available steps
   with their keys — the candidate chooses the path; the model grades whichever
   analysis they actually do and emits <step>N</step> for each one completed. */
// EN-NATIVE CASES (EN-canon wave, from 2026-07-25). A case authored natively in
// English must NOT be run through the "internal material is Russian, rephrase it
// yourself" instruction — that instruction invites the model to paraphrase, and
// paraphrase is exactly what kills a trap: the deliberate ambiguity in a step
// question ("which family looks worst?" — worst BY WHAT?) gets helpfully
// clarified away and the case is dead. For these cases the text IS the script.
// VERBATIM BRIEF (2026-07-25). "Present the prompt in your own words" is fatal on
// an EN-native case: the trap lives in what the brief deliberately does NOT say.
// #131 says "the board has been looking at margin" — ticket margin or realized
// margin is exactly the question, and a natural-sounding retelling ("reviewed
// gross margin by family and flagged the least profitable one") resolves the
// ambiguity while adding no fact at all. A retold brief is also outside every
// gate we run: we check numbers, structure and absence of hints in the FILE, and
// none of that binds text regenerated per run. So: the frame may be improvised,
// the brief may not.
const OPENING_VERBATIM =
`\n\nBRIEF — VERBATIM. The CASE PROMPT above is the client brief. Reproduce it WORD FOR WORD in your opening turn; it must appear in your reply exactly as written, as a contiguous block. You MAY add a short conversational frame around it — a greeting, "let me give you the situation", "take a minute if you need it" — but you may NOT paraphrase, shorten, expand, reorder or "clarify" the brief itself. Where it is vague about which metric or which measure, that vagueness is the test: leave it exactly as vague as it is written.`;

const languageEnNative =
`\n\n════ OUTPUT ════
Conduct the case in natural consulting English. The internal material below is ALREADY written in English and was authored natively for this case — it is NOT a translation and must NOT be paraphrased "into better English".
- Ask each step question in the words given. Do not reword, expand, or explain it.
- Where a question is deliberately unspecific, that ambiguity IS the test. Never add the missing qualifier (never turn "which looks worst?" into "which has the worst margin?"), and never hint at which metric to use unless the answer key tells you to.
- Keep every number, unit, percentage and proper name exactly as written.
- Keep the hidden markers (<step>…</step>, <verdict>…</verdict>, <reveal>…</reveal>) exactly as written; never explain or display them.`;

/* 2026-08-07. В режиме, которым идёт BCG (interviewee-led), лестницы подсказок
   НЕ БЫЛО ВООБЩЕ: `hintsBlock` вызывался только на линейном пути. Здесь стояла
   одна строка — «a short, demanding nudge toward the right MOVE» — и модель
   исполняла её буквально: на первой же ошибке называла ход.
   Замер: кейс #161, первая попытка, ответ содержал и наличие ловушки, и механизм,
   и метод. Кандидату оставалась арифметика.
   Теперь ilead получает ту же лестницу, что и линейный путь. Уровень попытки
   приходит от клиента (`attemptCount`), который теперь считает промахи и в этом
   режиме тоже; просьба о помощи читается из слов самого кандидата — отдельной
   кнопки нет и не будет, «мне нужна помощь» кандидат обязан произнести сам,
   и эти слова остаются в стенограмме, которую читает разбор. */
export function buildSystemPromptILead({ caseObj, doneSteps, firm, revealedSet, isOpening, focusKey, lang, attemptCount, hintAsked }) {
  const enNative = String(caseObj.lang || caseObj.source_lang || '').toLowerCase() === 'en' && lang !== 'ru';
  const steps = caseObj.steps || [];
  const byNum = new Map(steps.map(s => [s.step, s]));
  const done = new Set((Array.isArray(doneSteps) ? doneSteps : []).map(Number));
  const unlocked = unlockedStepNums(steps, done);
  const lockedNums = steps.map(s => s.step).filter(n => !done.has(n) && !unlocked.includes(n));
  // terminal = the deliverable step (case-level tag). Usually the final synthesis;
  // some cases (e.g. no synthesis step) mark the main calc as terminal. Case is
  // "done" once the terminal step is closed, even if optional steps remain.
  const terminalNum = Number.isInteger(Number(caseObj.terminal)) ? Number(caseObj.terminal) : (steps.length ? steps[steps.length - 1].step : null);
  const allDone = (terminalNum != null && done.has(terminalNum)) || (unlocked.length === 0 && lockedNums.length === 0);
  // optimal_entry = the layer-0 step a strong candidate opens with. Reference for
  // grading/steering the FIRST move only — never a gate; any depends_on:[] step
  // is a legitimate opening.
  const optEntry = Number(caseObj.optimal_entry);
  const optStep = Number.isInteger(optEntry) ? byNum.get(optEntry) : null;
  const openingRef = optStep
    ? `\n\n════ STRONGEST OPENING (reference — do not force) ════
A strong candidate opens with Step ${optEntry} — "${optStep.label || ''}" (${optStep.produces || ''}). Use this ONLY to judge the quality of their first move and to steer if they are lost at the very start. ANY step marked depends_on:[] (available now) is a legitimate opening — never penalise choosing a different valid starter, and never name Step ${optEntry} unless they stall.`
    : '';

  const header =
`You are an elite MBB case interviewer for CasEdge running a REAL casebook case from the CasEdge library. This case is fully authored in advance — every number, exhibit and answer is fixed. You must NEVER invent, change, or contradict any figure. Only reveal data that appears below, and only when the candidate reaches it.

FIRM STYLE: ${firmStyle(firm)}

CASE: "${caseObj.title}" — ${caseObj.case_type} · ${caseObj.industry} · ${caseObj.difficulty}

CASE PROMPT (the scenario):
${caseObj.prompt_md || caseObj.header_md || ''}`;

  const doneText = done.size
    ? `\n\n════ ALREADY ESTABLISHED (do not re-ask; these numbers/insights are known) ════\n` +
      [...done].sort((a,b)=>a-b).map(n => { const s = byNum.get(n) || {}; return `- Step ${n} "${safeLabel(s.label)}" → ${safeProduces(s.produces) || 'done'}`; }).join('\n')
    : '';

  const availText = unlocked.length
    ? `\n\n════ AVAILABLE NOW — the candidate may take ANY of these, in ANY order ════
Each block is one analysis the candidate can legitimately do next. Grade whichever they actually pursue against its ANSWER KEY. NEVER read a key aloud.\n\n` +
      unlocked.map(n => { const s = byNum.get(n) || {};
        return `— STEP ${n} — "${safeLabel(s.label)}" (yields: ${safeProduces(s.produces)||'—'})\nQUESTION IF THEY GO HERE:\n${s.candidate_md || safeLabel(s.label) || ''}${stepLangNote(s.candidate_md)}\nANSWER KEY (hidden — grade against this):\n${s.interviewer_md || '(no explicit key — grade with MBB rigor for this step type)'}`;
      }).join('\n\n')
    : '';

  const lockedText = lockedNums.length
    ? `\n\n════ NOT YET AVAILABLE (needs earlier results first) ════\n` +
      lockedNums.map(n => { const s = byNum.get(n) || {}; const need = (s.depends_on||[]).filter(d=>!done.has(d));
        return `- Step ${n} "${s.label||''}" — unlocks once these are established: ${need.map(d=>`Step ${d}`).join(', ')}. If the candidate jumps here, don't reject them — note briefly what they need first and let them get it, or answer what can be answered without the missing piece.`; }).join('\n')
    : '';

  const ex = exhibitsBlock(caseObj, revealedSet);

  let flow, flowRules = '';
  if (isOpening) {
    flow =
`\n\n════ WHAT TO DO NOW (OPENING) ════
Present the case prompt/scenario${enNative ? ' (see BRIEF — VERBATIM below)' : ' in your own words'} and hand over any exhibits marked "available to share" only if the opening calls for them. Then STOP and let the candidate drive — ask what they would like to look at first. Do NOT walk them through steps in order, do NOT evaluate, do NOT emit any <verdict> or <step> marker on this opening turn.` + (enNative ? OPENING_VERBATIM : '');
  } else {
    flowRules =
`\n\n════ WHAT TO DO NOW (INTERVIEWEE-LED) ════
The candidate drives. Respond to what they actually ask or compute.

MARKERS (the VERY FIRST characters of your reply, before any visible text):
- For EACH available step the candidate has just COMPLETED to its key this turn, emit <step>N</step> immediately followed by <verdict>pass</verdict>. Multiple allowed (e.g. <step>2</step><verdict>pass</verdict> then continue). Then do NOT march to a "next" step — briefly acknowledge and ask what they want to tackle next (their choice).
- If they attempted an available step but did NOT meet its key, emit <verdict>retry</verdict> and respond EXACTLY as the HINT POLICY below allows for the current attempt — on attempt 1 that is one question and nothing else. Do NOT name the move. Do NOT emit <step> for it.
- If they only asked for data / are still exploring / went down an empty path, emit NEITHER marker — answer in character and let them continue. A dead-end path is fine: let them see it's empty and come back; recovering is their skill to show, not yours to block.

Rules for every reply:
- Order is the candidate's choice — NEVER penalise doing cost before revenue, or any valid ordering. Only a real data dependency (a locked step) gates anything.
- An alternative route to the SAME correct number is a PASS — grade the result and the logic, not whether it matches the written path.
- NEVER write grading words ("pass", "retry", "зачёт") in visible text — markers are the only grading signal.
- Reveal a GATED exhibit only when the candidate asks about its triggers, using <reveal>id</reveal> right after any step/verdict markers.
- Zero filler. Concise, concrete, numeric. Never present a number not in the case material; never change a number you already gave.`;
    flow = allDone
      ? '\n\nALL analyses are done. Require the final recommendation now: ask them to deliver it conclusion-first (Pyramid), with the key numbers, risks (\u22651 internal + \u22651 external), and next steps. Grade it against the recommendation step key.'
      : '\n\nWhen the remaining work is only the final recommendation, ask for it conclusion-first.';
  }

  const languageRu =
`\n\n════ OUTPUT ════
Веди кейс ПОЛНОСТЬЮ НА РУССКОМ ЯЗЫКЕ. Профессиональный консалтинговый русский; стандартные термины (NPV, EBITDA, churn, capex, MECE) допустимы. Названия кейсов и компаний — как написаны. Все числа — точно из материала. Скрытые маркеры (<step>…</step>, <verdict>…</verdict>, <reveal>…</reveal>) оставляй ровно как есть; кандидату не показывай.`;
  const language = (lang === 'ru') ? languageRu : enNative ? languageEnNative :
`\n\n════ OUTPUT ════
Conduct the case in natural consulting English. Internal material below (questions, keys, exhibit notes) may be in RUSSIAN — that is source, never quote it; rephrase in English. Keep every number, unit, percentage and proper name EXACTLY as written. Keep the hidden markers (<step>…</step>, <verdict>…</verdict>, <reveal>…</reveal>) exactly as written; never explain or display them.`;

  const stable = header + openingRef + ex.stableText + language + flowRules;
  /* Лестница подсказок теперь и здесь. Тексты L1/L2 конкретного шага НЕ подаются:
     в этом режиме кандидат может стоять на любом из разблокированных шагов, и
     подать подсказку не того шага — значит слить чужой ключ. Подаётся правило
     уровня, ключи у модели и так есть. */
  const hints = isOpening ? '' : hintsBlock(null, attemptCount, hintAsked);
  const volatile = doneText + availText + lockedText + ex.volatileText + hints + (isOpening ? '' : focusBlock(focusKey)) + flow;
  return { stable, volatile };
}

/* ───────────────────────── system prompt assembly ───────────────────────────
   Rebuilt for the CURRENT step on every call. interviewer_md is the answer key,
   used only to grade — never read aloud. */
export function buildSystemPrompt({ caseObj, stepIndex, attemptCount, firm, revealedSet, isOpening, focusKey, lang, overCap, hintAsked }) {
  const enNative2 = String(caseObj.lang || caseObj.source_lang || '').toLowerCase() === 'en' && lang !== 'ru';
  const steps = caseObj.steps || [];
  const idx = Math.max(0, Math.min(stepIndex, steps.length - 1));
  const step = steps[idx] || {};
  const nextStep = steps[idx + 1] || null;
  const isLast = idx >= steps.length - 1;

  const header =
`You are an elite MBB case interviewer for CasEdge running a REAL casebook case from the CasEdge library. This case is fully authored in advance — every number, exhibit and answer is fixed. You must NEVER invent, change, or contradict any figure. Only reveal data that appears below, and only when the candidate reaches it.

FIRM STYLE: ${firmStyle(firm)}

CASE: "${caseObj.title}" — ${caseObj.case_type} · ${caseObj.industry} · ${caseObj.difficulty}

CASE PROMPT (the scenario):
${caseObj.prompt_md || caseObj.header_md || ''}`;

  const answerKey =
`\n\n════ ANSWER KEY FOR THE CURRENT STEP — NEVER READ THIS ALOUD ════
This is grading material only. NEVER quote, paraphrase, summarise, or hand any of it to the candidate. If the step text below happens to contain the model answer or a python/solution block, speak ONLY the question part — never the solution.

CURRENT STEP ${idx + 1} of ${steps.length} — "${safeLabel(step.label)}"
QUESTION TO ASK THE CANDIDATE:
${step.candidate_md || safeLabel(step.label) || ''}${stepLangNote(step.candidate_md)}

ANSWER KEY (hidden — grade against this):
${step.interviewer_md || '(No explicit key parsed for this step. Grade using the case prompt, the exhibits, and standard MBB rigor for a step of this type. Any answer text embedded in the question above is interviewer-side — do not read it out.)'}`;

  const ex = exhibitsBlock(caseObj, revealedSet);
  const hints = hintsBlock(step, attemptCount, hintAsked);

  let flow;
  if (isOpening) {
    flow =
`\n\n════ WHAT TO DO NOW (OPENING) ════
This is the start of the case. Do the following, briefly and in character:
1. Present the case prompt / scenario to the candidate${enNative2 ? ' (see BRIEF — VERBATIM below)' : ' in your own words'}.
2. Present any EXHIBITS marked "available to share" above only if this first step calls for them; otherwise hold them.
3. Ask the CURRENT STEP question above.
Do NOT evaluate anything yet and do NOT emit a <verdict> marker on this opening turn. Keep it tight and professional — no filler.` + (enNative2 ? OPENING_VERBATIM : '');
  } else {
    const advance = isLast
      ? `Since this is the LAST step, do NOT ask a new question — give a brief, professional closing line and stop.`
      : `Then transition and ask the NEXT step's question:\n"${(nextStep && (nextStep.candidate_md || safeLabel(nextStep.label))) || ''}"${nextStep ? stepLangNote(nextStep.candidate_md) : ''}`;
    flow =
`\n\n════ WHAT TO DO NOW (EVALUATE) ════
Grade the candidate's latest message against the ANSWER KEY for the current step.

YOUR REPLY MUST START with exactly one hidden verdict marker — the VERY FIRST characters of your reply, before any visible text:
- <verdict>pass</verdict> if the answer meets the bar for this step (key insight / correct math / required structure). ${advance}
- <verdict>retry</verdict> if it does not yet meet the bar — then respond EXACTLY as the HINT POLICY below allows for the current attempt, and nothing more. On attempt 1 that is one question and nothing else: do NOT name the move. Do NOT advance.
This marker is MANDATORY on every evaluating reply. A reply without it breaks the app. Any <reveal> marker comes immediately after the verdict marker.

Rules for every reply:
- NEVER write grading words like "Pass", "Retry", "зачёт" in the VISIBLE text — the marker is the only grading signal; the candidate must not see explicit grades mid-case.
- Reveal a GATED exhibit only when the candidate asks about its triggers, using <reveal>id</reveal> right after the verdict marker.
- Zero filler ("great question", "let me think"). Be concise, concrete, numeric. 2–5 sentences plus at most one question.
- Never present a number that is not in the material above. Never change a number you already gave.`;
  }

  const languageRu =
`\n\n════ OUTPUT ════
Веди кейс ПОЛНОСТЬЮ НА РУССКОМ ЯЗЫКЕ — каждый вопрос, каждая реплика, каждая подсказка. Профессиональный консалтинговый русский: стандартные термины (NPV, EBITDA, churn, capex, MECE) допустимы как есть, но никаких английских ФРАЗ и предложений. Названия кейсов и компаний оставляй как написаны. Все числа, единицы и проценты — в точности из материала. Скрытые маркеры (<verdict>…</verdict>, <reveal>…</reveal>) оставляй ровно как есть; кандидату их не показывай и не объясняй.`;
  const language = (lang === 'ru') ? languageRu : enNative2 ? languageEnNative :
`\n\n════ OUTPUT ════
Conduct the case in English. Much of the internal material below (step questions, answer keys, hints, exhibit notes) is written in RUSSIAN — that is source material, not something to quote. ALWAYS speak to the candidate in natural, idiomatic consulting English:
- Rephrase every step question and data introduction in English yourself — never paste the Russian text into your reply, and never mix Russian phrases into an English sentence.
- Translate meaning, not words: keep the wit and tone (case titles and puns stay AS WRITTEN — never translate a proper name or title), and keep every number, unit, percentage and company name EXACTLY as in the source.
- Hints/nudges you deliver must also be in English, rephrased naturally.
Keep the hidden markers EXACTLY as written (<verdict>…</verdict>, <reveal>…</reveal>) so the app can parse them; never explain or display them to the candidate.`;

  // Split into a STABLE block (case identity + firm + prompt + auto exhibits +
  // output rules — identical every turn of this case, so it is prompt-cached)
  // and a VOLATILE block (current step's question/answer key, gated exhibits,
  // hint policy, flow — changes each turn). This keeps full accuracy while
  // making the big re-sent case body a cache hit on every turn after the first.
  /* Закрывающая директива. Стоит в ИЗМЕНЧИВОМ блоке, а не в постоянном:
     постоянный блок кеширован, и подмешивать в него условие значило бы
     обнулять кеш всем остальным ходам кейса. */
  const closing = overCap
    ? `\n\n════ ЗАКРЫВАЙ КЕЙС ════\nЭта партия шла необычно долго. Не задавай новых вопросов. Дай короткое закрытие: назови вывод по кейсу первым предложением, два-три факта с числами в его пользу, два риска и следующий шаг. Затем закончи. Не извиняйся и не объясняй, почему кейс закрывается.`
    : '';

  const stable = header + ex.stableText + language;
  const volatile = answerKey + ex.volatileText + hints + (isOpening ? '' : focusBlock(focusKey)) + flow + closing;
  return { stable, volatile };
}

/* ───────────────────────── infra (shared with claude.js pattern) ─────────── */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Retry transient Anthropic overloads (429/529) and 5xx with backoff so a
// capacity spike never surfaces as a broken interviewer turn.
const RETRIABLE_STATUS = new Set([429, 500, 502, 503, 529]);
async function fetchAnthropicWithRetry(url, options, timeoutMs, maxRetries) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(Math.min(700 * Math.pow(2, attempt - 1), 4000));
    try {
      const resp = await fetchWithTimeout(url, options, timeoutMs);
      if (RETRIABLE_STATUS.has(resp.status) && attempt < maxRetries) continue;
      return resp;
    } catch (e) {
      lastErr = e;
      if (attempt >= maxRetries) throw e;
    }
  }
  if (lastErr) throw lastErr;
}

async function rateLimited(userId, sbUrl, sbKey, token) {
  /* Ключ счётчика разведён по ручкам — см. api/_auth.js. До этого все
     восемь ручек делили одну строку, и порог 6 у транскрипции вместе
     с окном 300 секунд действовал на всех. */
  return rateLimitedScoped({ userId, scope: 'case', limit: RATE_LIMIT,
    windowSeconds: RATE_WINDOW_MS / 1000, sbUrl, sbKey, token, timeoutMs: AUTH_TIMEOUT_MS });
}

function hasAssistantTurn(messages) {
  return Array.isArray(messages) && messages.some(m => m && m.role === 'assistant');
}

/* ───────────────────────── handler ───────────────────────────────────────── */
export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || FALLBACK_ORIGIN;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });

  try {
    // 1) Require a Supabase bearer token.
    const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: { message: 'Authentication required.' } });

    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_ANON_KEY;
    if (!sbUrl || !sbKey) return res.status(500).json({ error: { message: 'Server auth not configured.' } });

    // 2) Body size limit before any network call.
    const raw = JSON.stringify(req.body || {});
    if (raw.length > MAX_BODY_BYTES) return res.status(413).json({ error: { message: 'Request too large.' } });

    // Одна проверка сессии на всё приложение — ./_auth.js, с кешем на инстанс.
    // Раньше каждый вызов ходил в /auth/v1/user по сети; на тёплом инстансе
    // повторная проверка того же токена теперь не идёт в сеть вовсе.
    const user = await verifyUserCached(token, AUTH_TIMEOUT_MS);
    if (!user) return res.status(401).json({ error: { message: 'Invalid or expired session.' } });
    const userId = user.id;

    const body = req.body || {};

    // 4) list action — no model call, meta only.
    if (body.action === 'list') {
      return res.status(200).json({ cases: listCases() });
    }

    // 4b) pick action — adaptive auto-selection, no model call, meta only.
    if (body.action === 'pick') {
      return res.status(200).json(pickCase({
        caseType: body.caseType,
        level: body.level,
        seenIds: body.seenIds,
        rand: Math.random()
      }));
    }

    // 5) Per-user rate limit (only the model-calling path).
    if (await rateLimited(userId, sbUrl, sbKey, token)) {
      return res.status(429).json({ error: { message: 'Too many requests. Please slow down.' } });
    }

    // 6) Resolve case + step.
    const caseObj = lib().byId.get(String(body.caseId));
    if (!caseObj) return res.status(400).json({ error: { message: 'Unknown case.' } });
    const steps = Array.isArray(caseObj.steps) ? caseObj.steps : [];
    if (!steps.length) return res.status(400).json({ error: { message: 'Case has no steps.' } });

    let stepIndex = Number(body.stepIndex);
    if (!Number.isInteger(stepIndex) || stepIndex < 0) stepIndex = 0;
    if (stepIndex > steps.length - 1) stepIndex = steps.length - 1;

    const attemptCount = Number(body.attemptCount) || 0;
    const priorRevealed = Array.isArray(body.revealedExhibits) ? body.revealedExhibits.filter(x => typeof x === 'string') : [];
    const revealedSet = new Set(priorRevealed);

    // Client sends only role/content. Keep the FULL case transcript (cap at 80
    // messages as a runaway guard) so the interviewer never forgets what the
    // candidate said earlier in the case — the conversation prefix is prompt-
    // cached below, so full memory costs almost nothing after the first turn.
    const clientMsgs = Array.isArray(body.messages) ? body.messages : [];
    /* Реплика кандидата обрезается по длине. Это не только про деньги: на живом
       интервью ответ длиннее полутора минут перебивают, и тренажёр, который
       поощряет простыню, готовит не к тому. Обрезка видна модели явно, чтобы
       она не судила оборванную мысль как незаконченную. */
    let trimmedTurns = 0;
    const capped = clientMsgs
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map(m => {
        if (m.role === 'user' && m.content.length > MAX_CANDIDATE_CHARS) {
          trimmedTurns++;
          return { role: m.role, content: m.content.slice(0, MAX_CANDIDATE_CHARS) + ' […реплика обрезана по длине]' };
        }
        return { role: m.role, content: m.content };
      })
      .slice(-80);
    const win = windowTranscript(capped, TRANSCRIPT_CEILING_TOKENS, TRANSCRIPT_FLOOR_TOKENS, DROP_BLOCK);
    const messages = win.kept;

    /* Потолок держится ОСТАНОВКОЙ, а не сжатием — и вот почему.
       Прогон гейта показал: в патологической партии (12 шагов, 5 повторов,
       простыни) один только ВЫХОД модели стоит $0.16 из $0.20. Сжимать
       стенограмму до потолка пришлось бы примерно до тысячи токенов — то есть
       отобрать память у всех нормальных партий ради поведения, которого почти
       не бывает. Вместо этого нормальные партии живут с полной памятью, а
       ненормальная закрывается: интервьюер доводит кейс до рекомендации и
       заканчивает. Это ещё и честнее по сути: партия на семьдесят реплик —
       это не тренировка интервью, интервью столько не длится. */
    let spentUsd = 0, overCap = false;   // считается ниже, когда собран промпт


    const isOpening = !hasAssistantTurn(messages);
    // Anthropic requires the conversation to start with a user turn.
    const convo = messages.length ? messages : [{ role: 'user', content: 'Please begin the case.' }];
    if (convo[0].role !== 'user') convo.unshift({ role: 'user', content: 'Please begin the case.' });
    /* ...and to END with one. Fixing only the first turn cost a live 400 on
       06.08: the client sends a transcript ending with the interviewer's turn
       whenever the step advances without a candidate reply, and upstream
       answers "This model does not support assistant message prefill" - which
       the candidate reads as "The interviewer is busy right now". The trailing
       nudge is neutral: it carries no case content and no instruction beyond
       "keep going", so it cannot change what the interviewer asks next. */
    if (convo[convo.length - 1].role !== 'user') {
      convo.push({ role: 'user', content: 'Please continue.' });
    }

    // Cache the conversation prefix: mark the last message as a cache breakpoint
    // so every prior turn is a cache hit on the next request.
    const lastMsg = convo[convo.length - 1];
    convo[convo.length - 1] = {
      role: lastMsg.role,
      content: [{ type: 'text', text: lastMsg.content, cache_control: { type: 'ephemeral' } }]
    };

    // Weakness focus: whitelist key only — free text never enters the prompt.
    /* ПОТОК. Клиент просит его явно (`stream:true`); без флага всё работает
       ровно как раньше — старые клиенты и повторы не ломаются. */
    const wantStream = body.stream === true || body.stream === 1;
    const focusKey = ['structure','quant','logic','comm','ownership'].includes(body.focusDimension) ? body.focusDimension : null;
    const lang = body.lang === 'ru' ? 'ru' : 'en';   // whitelist

    // Interviewee-led (BCG/Bain on a graph-ready case): the candidate drives, the
    // engine holds only real dependencies. Everything else (McKinsey, or any case
    // without depends_on tags) stays on the untouched linear path — full backward
    // compatibility. Client opts in by sending mode:'ilead' + doneSteps[].
    const ilead = body.mode === 'ilead' && firmIsCandidateLed(body.firm) && caseIsGraphReady(steps);
    const doneSteps = Array.isArray(body.doneSteps) ? body.doneSteps.map(Number).filter(Number.isInteger) : [];
    /* Просьба о помощи читается из слов кандидата, а не из кнопки. Кнопку решили
       не заводить: на интервью её нет, и произнести «я застрял» — само по себе
       часть навыка. Слова остаются в стенограмме, и разбор их видит. */
    const hintAsked = candidateAskedForHint(clientMsgs);
    const build = (over) => ilead
      ? buildSystemPromptILead({ caseObj, doneSteps, firm: body.firm, revealedSet, isOpening, focusKey, lang,
                                 attemptCount, hintAsked })
      : buildSystemPrompt({ caseObj, stepIndex, attemptCount, firm: body.firm, revealedSet, isOpening, focusKey, lang, overCap: over, hintAsked });

    /* ПОТОЛОК СЧИТАЕТСЯ ЗДЕСЬ, а не выше: цена хода зависит от размера
       изменчивого блока, а он известен только после сборки промпта. Собираем
       один раз «как обычно», меряем, и если партия упирается в потолок —
       пересобираем с директивой закрытия. Пересборка — чистая работа со
       строками, сети не касается.

       Закрываем не когда потолок ПРОЙДЕН, а когда следующий ход его пробьёт:
       стоимость хода известна, и тратить её, чтобы потом обнаружить перерасход,
       — это и есть перерасход. */
    let built = build(false);
    const volatileTok = estTokens(built.volatile);
    const stableTok = estTokens(built.stable);
    spentUsd = estimateSpentUsd(capped, stableTok, volatileTok);
    const NEXT_TURN_USD = ((stableTok + TRANSCRIPT_CEILING_TOKENS) * PRICE_IN_PER_MTOK * CACHE_READ_MULT
      + volatileTok * PRICE_IN_PER_MTOK * CACHE_WRITE_MULT
      + 260 * PRICE_OUT_PER_MTOK) / 1e6;
    /* Поправка калибровки. Оценка считает по среднему ходу и systematically
       занижает: первые ходы платят полную запись (кешируемого начала ещё нет),
       а блочный выброс изредка рвёт кеш. Сверка с гейтом на боевом обработчике
       (`06_Обмен/DEV/gate_case_price_cap.js`, семь сценариев) дала занижение
       около четверти. Множитель назван числом и живёт рядом с оценкой, чтобы
       его пересчитывали при смене закона, а не искали по коду. */
    const CAP_CALIBRATION = 1.25;
    overCap = spentUsd * CAP_CALIBRATION + NEXT_TURN_USD >= CASE_PRICE_CAP_USD;
    if (overCap && !ilead) built = build(true);

    // 7) Forward to Anthropic. Two system blocks: the STABLE case body is cached
    // (identical every turn → cache hit); the VOLATILE step block is not.
    // УПРАВЛЕНИЕ РАЗМЫШЛЕНИЕМ. Замер 29.07 на живом проде показал: этот модель
    // НЕ принимает `thinking:{type:'enabled',budget_tokens}` — апстрим отвечает
    // 400 и прямо называет замену:
    //   "thinking.type.enabled" is not supported for this model.
    //   Use "thinking.type.adaptive" and "output_config.effort".
    // До этой правки каждый ход делал ДВА http-запроса: отвергнутый и откат.
    // Теперь сразу правильная форма, а откат остаётся страховкой на случай,
    // если и её версия API не примет.
    const MODES = [
      { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } },
      { thinking: { type: 'adaptive' } },
      null                                   // без управления — как было
    ];
    let _mode = 0;
    const buildBody = (maxTok, useMode) => {
      /* ПОРЯДОК БЛОКОВ РЕШАЕТ, РАБОТАЕТ ЛИ КЕШ.
         Кеш апстрима совпадает по самому длинному общему НАЧАЛУ запроса.
         Изменчивый блок (текущий шаг, ключ, подсказки) стоял в `system`, то есть
         ПЕРЕД всей стенограммой, — и любая смена шага делала непохожим всё, что
         за ним. Отсюда замеренное на проде `cache_read: 0` при каждой смене шага.
         Теперь изменчивое уезжает В КОНЕЦ, последним ходом разговора: постоянная
         часть кейса и вся стенограмма остаются общим началом и читаются из кеша.
         Модель видит тот же текст и в том же порядке относительно вопроса —
         инструкция стоит непосредственно перед тем, на что она влияет. */
      const b = {
        model: CASE_MODEL,
        max_tokens: maxTok,
        system: [
          { type: 'text', text: built.stable, cache_control: { type: 'ephemeral' } }
        ],
        messages: convo.concat([{ role: 'user', content: [{ type: 'text', text: built.volatile }] }])
      };
      if (useMode && MODES[_mode]) Object.assign(b, MODES[_mode]);
      if (wantStream) b.stream = true;
      return JSON.stringify(b);
    };
    const post = (payload, timeoutMs, retries) => fetchAnthropicWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31'
      },
      body: payload
    }, timeoutMs != null ? timeoutMs : UPSTREAM_TIMEOUT_MS, retries != null ? retries : 4);

    const callModel = async (maxTok, timeoutMs, retries, useMode) => {
      let resp = await post(buildBody(maxTok, useMode), timeoutMs, retries);
      // Спускаемся по списку режимов, пока апстрим не примет форму.
      while (useMode && resp.status === 400 && _mode < MODES.length - 1) {
        const txt = await resp.clone().text().catch(() => '');
        if (!/thinking|output_config|effort/i.test(txt)) break;
        console.error('case-session: mode', _mode, 'rejected —', txt.slice(0, 160));
        _mode++;
        resp = await post(buildBody(maxTok, useMode), timeoutMs, retries);
      }
      return resp;
    };

    const extractText = (data) => Array.isArray(data && data.content)
      ? data.content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim()
      : '';

    const T0 = Date.now();
    const BUDGET_MS = 52 * 1000;
    let response;
    try {
      // Открывающий ход НЕ оценивает: модель просто представляет кейс и молчит
      // (verdict на нём принудительно null, markers запрещены). Думать там не над
      // чем — режем бюджет до минимума. Это экономия без единой потери качества,
      // в отличие от снижения бюджета на оценочных ходах.
      response = await callModel(MAX_TOKENS, 45 * 1000, 1, !isOpening);
    } catch (e) {
      return res.status(504).json({ error: { message: 'The interviewer is taking too long. Please try again.' } });
    }

    /* Заголовки SSE НЕ ставим, пока не пришёл первый кусок текста. Пока их нет,
       можно честно откатиться на обычный путь: пустой ответ, ретрай, 503.
       Поставив заголовки заранее, мы бы отрезали себе все эти ветки. */
    let sseOpen = false;
    const sseSend = (obj) => { res.write('data: ' + JSON.stringify(obj) + '\n\n'); };
    const openSse = () => {
      if (sseOpen) return;
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');   // без этого прокси копит буфер и стрим бессмысленен
      sseOpen = true;
    };
    let streamedText = '';
    let streamUsage = null;   // вход/кеш приходят в message_start, выход — в message_delta

    /* ЗАДЕРЖКА ПЕРВОЙ СТУПЕНИ. Проверить ответ на чужие числа можно только когда
       он дописан, а отправленное потоком уже не вернуть. Поэтому на ПЕРВОЙ
       попытке текст придерживается — но лишь до вердикта, а вердикт модель
       обязана поставить самыми первыми знаками ответа. Если это не разбор
       ошибки (pass или просто выдача данных), придержанное тут же уходит
       кандидату и дальше поток идёт как обычно: задержка в несколько десятков
       миллисекунд. Держится до конца только тот случай, ради которого всё
       и делается, — первая ошибка кандидата. */
    const firstAttempt = (Number(attemptCount) || 0) === 0;
    const lastCandidateText = (() => {
      for (let i = clientMsgs.length - 1; i >= 0; i--)
        if (clientMsgs[i] && clientMsgs[i].role === 'user') return String(clientMsgs[i].content || '');
      return '';
    })();
    let holding = firstAttempt, heldText = '';
    if (wantStream && response.status >= 200 && response.status < 300 && response.body) {
      const filter = createMarkerFilter();
      const reader = response.body.getReader();
      const dec = new TextDecoder();
      let sseBuf = '';
      try {
        for (;;) {
          const { done: rdone, value } = await reader.read();
          if (rdone) break;
          sseBuf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = sseBuf.indexOf('\n')) >= 0) {
            const line = sseBuf.slice(0, nl).trim();
            sseBuf = sseBuf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            let ev; try { ev = JSON.parse(raw); } catch (e) { continue; }
            if (ev.type === 'content_block_delta' && ev.delta && typeof ev.delta.text === 'string') {
              streamedText += ev.delta.text;
              const safe = filter.push(ev.delta.text);
              if (holding) {
                heldText += safe;
                // вердикт стоит в самом начале ответа — как только он виден, решаем
                const vm = streamedText.match(/<verdict>\s*(pass|retry)\s*<\/verdict>/i);
                if (vm && vm[1].toLowerCase() !== 'retry') {
                  holding = false;
                  if (heldText) { openSse(); sseSend({ t: heldText }); heldText = ''; }
                }
              } else if (safe) { openSse(); sseSend({ t: safe }); }
            } else if (ev.type === 'message_start' && ev.message && ev.message.usage) {
              /* Вход и кеш приходят ТОЛЬКО в message_start; в message_delta их нет.
                 Пока мы читали один message_delta, лог знал лишь выходные токены —
                 то есть на потоковом пути, которым ходят живые люди, стоимость
                 была невидима вовсе. Замер 06.08 показал, зачем это нужно:
                 cache_read = 0 на каждом ходу после открывающего, при
                 cache_write 2.3–3.0k — мы платим за запись кеша, который никто
                 не читает. Без этой строки такое не увидеть. */
              const u = ev.message.usage;
              streamUsage = { in: u.input_tokens, cache_read: u.cache_read_input_tokens,
                              cache_write: u.cache_creation_input_tokens };
            } else if (ev.type === 'message_delta' && ev.usage) {
              const su = streamUsage || {};
              const costUsd = ((su.in || 0) * PRICE_IN_PER_MTOK
                + (su.cache_write || 0) * PRICE_IN_PER_MTOK * CACHE_WRITE_MULT
                + (su.cache_read || 0) * PRICE_IN_PER_MTOK * CACHE_READ_MULT
                + (ev.usage.output_tokens || 0) * PRICE_OUT_PER_MTOK) / 1e6;
              console.log('case-session cost', JSON.stringify({
                build: BUILD, case: caseObj.id, step: stepIndex, usd: +costUsd.toFixed(5),
                mode: _mode, dropped: win.dropped, trimmed: trimmedTurns }));
              console.log('case-session usage(stream)', JSON.stringify(Object.assign(
                { case: caseObj.id, step: stepIndex, out: ev.usage.output_tokens }, su)));
            }
          }
        }
        const tail = filter.flush();
        if (holding) heldText += tail;
        else if (tail) { openSse(); sseSend({ t: tail }); }
      } catch (e) {
        console.error('case-session stream read failed:', e && e.message);
        // Уже что-то отдали — честно закрываем ошибкой; ещё нет — падаем на обычный путь.
        if (sseOpen) { sseSend({ error: 'stream broken' }); res.end(); return; }
        streamedText = '';
      }
    }

    /* ПРОВЕРКА И ОДНА ПЕРЕПИСКА. Дошли сюда с придержанным текстом — значит это
       разбор первой ошибки. Смотрим, не названо ли число, которого кандидат не
       писал; если названо, просим переписать РОВНО ОДИН раз. Один, а не до
       победы: вторая неудача означает, что случай не берётся правилом, и тогда
       честнее отдать как есть, чем крутить деньги кандидата в цикле. */
    if (holding && heldText) {
      const bad = foreignFigures(heldText, lastCandidateText);
      if (bad.length) {
        console.log('case-session hint leak', JSON.stringify({
          build: BUILD, case: caseObj.id, figures: bad.slice(0, 4) }));
        try {
          const strict = built.volatile
            + '\n\nYOUR PREVIOUS ATTEMPT AT THIS REPLY WAS REJECTED. It contained the figure '
            + bad.slice(0, 3).join(', ') + ', which the candidate never wrote. That names the row '
            + 'they missed, which is the answer. Ask a SHORTER, VAGUER question that contains NO '
            + 'figure at all and points only at their own claim. Keep the verdict marker.';
          const rb = JSON.stringify({ model: CASE_MODEL, max_tokens: 300,
            system: [{ type: 'text', text: built.stable, cache_control: { type: 'ephemeral' } }],
            messages: convo.concat([{ role: 'user', content: [{ type: 'text', text: strict }] }]) });
          // без stream и без ретраев: ход короткий, а ждать кандидат уже ждёт
          const rr = await post(rb, 20000, 0);
          if (rr.ok) {
            const rj = await rr.json();
            /* Перепись — ВТОРОЙ оплаченный вызов. Без этой строки лог показывал бы
               цену только первой попытки, то есть занижал бы ровно те ходы, где
               движок ошибся и его просили заново. Замер 08.08: перепись сработала
               на трёх ходах из трёх, и все три были посчитаны наполовину. */
            if (rj && rj.usage) {
              const ru = rj.usage;
              const rUsd = ((ru.input_tokens || 0) * PRICE_IN_PER_MTOK
                + (ru.cache_creation_input_tokens || 0) * PRICE_IN_PER_MTOK * CACHE_WRITE_MULT
                + (ru.cache_read_input_tokens || 0) * PRICE_IN_PER_MTOK * CACHE_READ_MULT
                + (ru.output_tokens || 0) * PRICE_OUT_PER_MTOK) / 1e6;
              console.log('case-session hint rewrite cost', JSON.stringify({
                build: BUILD, case: caseObj.id, usd: +rUsd.toFixed(5),
                in: ru.input_tokens, out: ru.output_tokens,
                cache_read: ru.cache_read_input_tokens, cache_write: ru.cache_creation_input_tokens }));
            }
            const txt = (rj.content || []).filter(b2 => b2 && b2.type === 'text')
              .map(b2 => b2.text).join('\n').trim();
            if (txt) {
              const f2 = createMarkerFilter();
              const visible = (f2.push(txt) + f2.flush()).trim();
              const still = foreignFigures(visible, lastCandidateText);
              console.log('case-session hint rewrite', JSON.stringify({
                build: BUILD, case: caseObj.id, ok: still.length === 0 }));
              if (visible) { streamedText = txt; heldText = visible; }
            }
          }
        } catch (e) { console.error('case-session hint rewrite failed:', e && e.message); }
      }
      openSse(); sseSend({ t: heldText }); heldText = ''; holding = false;
    }

    let data = wantStream && streamedText
      ? { content: [{ type: 'text', text: streamedText }], stop_reason: 'end_turn' }
      : await response.json();
    if (response.status < 200 || response.status >= 300) {
      // Pass through status; never leak upstream internals.
      console.error('case-session upstream non-2xx', response.status, JSON.stringify(data).slice(0, 300));
      return res.status(response.status).json({ error: { message: 'The interviewer is busy right now. Please try again.' } });
    }

    // Расход печатается всегда: пока его нет в логах, любой разговор о
    // стоимости — гадание. u.output_tokens включает thinking.
    if (data && data.usage) {
      const u = data.usage;
      /* Стоимость хода считается здесь и пишется в лог. Потолок, который никто
         не меряет, — это обещание. `mode` рядом не для красоты: если апстрим
         отверг режим и мы откатились, форма запроса изменилась, а изменение
         формы убивает кеш — и тогда «смена шага пишет всё заново» объясняется
         не границей блоков, а откатом. Без этого поля две разные причины
         выглядят в логе одинаково. */
      const costUsd = ((u.input_tokens || 0) * PRICE_IN_PER_MTOK
        + (u.cache_creation_input_tokens || 0) * PRICE_IN_PER_MTOK * CACHE_WRITE_MULT
        + (u.cache_read_input_tokens || 0) * PRICE_IN_PER_MTOK * CACHE_READ_MULT
        + (u.output_tokens || 0) * PRICE_OUT_PER_MTOK) / 1e6;
      console.log('case-session cost', JSON.stringify({
        build: BUILD, case: caseObj.id, step: stepIndex, usd: +costUsd.toFixed(5),
        mode: _mode, dropped: win.dropped, trimmed: trimmedTurns
      }));
      console.log('case-session usage', JSON.stringify({
        case: caseObj.id, step: stepIndex,
        in: u.input_tokens, out: u.output_tokens,
        cache_read: u.cache_read_input_tokens, cache_write: u.cache_creation_input_tokens,
        stop: data.stop_reason
      }));
    }
    let text = extractText(data);
    // Rare failure mode: the model spends the ENTIRE budget on a thinking block
    // (stop_reason max_tokens, no text). One automatic retry with more headroom.
    const timeLeft = BUDGET_MS - (Date.now() - T0);
    if (!text && data && data.stop_reason === 'max_tokens' && timeLeft > 12 * 1000) {
      console.error('case-session: thinking consumed budget, retrying with', MAX_TOKENS_RETRY, 'timeLeft', timeLeft);
      try {
        const resp2 = await callModel(MAX_TOKENS_RETRY, timeLeft - 2000, 0, false);
        if (resp2.status >= 200 && resp2.status < 300) {
          data = await resp2.json();
          text = extractText(data);
        }
      } catch (e) { /* fall through to the empty-text log below */ }
    }
    if (!text) {
      const shape = data && typeof data === 'object'
        ? JSON.stringify({ type: data.type, stop_reason: data.stop_reason, blocks: Array.isArray(data.content) ? data.content.map(b => b && b.type) : typeof data.content, err: data.error && data.error.type }).slice(0, 300)
        : String(data).slice(0, 200);
      console.error('case-session empty text from upstream:', shape);
    }
    // Пустой текст после ретрая — это НЕ ответ интервьюера, и подсовывать
    // кандидату строку-заглушку вместо реплики нельзя: он видит её как слова
    // интервьюера и теряет свой ход. Отдаём 503 — клиент на нём делает ещё
    // одну попытку сам, а если и она пуста, показывает честную ошибку.
    if (!text) {
      return res.status(503).json({ error: { message: 'The interviewer stalled on that one. Send your answer again — it is still in the box.' } });
    }
    const parsed = parseMarkers(text, priorRevealed);

    // On the opening turn we never advance — force verdict null.
    const verdict = isOpening ? null : parsed.verdict;

    // Visual exhibit payloads: for exhibits revealed on THIS turn that carry a
    // `render` spec, ship the render data so the client draws the chart/table.
    // Only meta + render — never body_md or any interviewer material.
    const priorSet = new Set(priorRevealed);
    const allExhibits = Array.isArray(caseObj.exhibits) ? caseObj.exhibits : [];
    const exhibitCards = parsed.revealedExhibits
      .filter(id => !priorSet.has(id))
      .map(id => {
        const ex = allExhibits.find(e => e && e.id === id);
        return (ex && ex.render) ? { id: ex.id, title: ex.title, render: ex.render } : null;
      })
      .filter(Boolean);
    // Opening turn: exhibits designed to be handed over at case start
    // (reveal:'auto' + render, e.g. "Блок 1 (сразу)") ship as cards immediately.
    if (isOpening) {
      for (const ex of allExhibits) {
        if (ex && ex.render && ex.reveal === 'auto' && !exhibitCards.some(c => c.id === ex.id)) {
          exhibitCards.push({ id: ex.id, title: ex.title, render: ex.render });
        }
      }
    }

    // Interviewee-led: tell the client which mode actually ran (so it tracks a
    // done-set vs a linear counter) and whether the terminal step is now done.
    const stepCompleted = (ilead && !isOpening) ? (parsed.completedSteps || []) : [];
    // Completion = the terminal step is done (case-level `terminal` tag, else the
    // last step). Some steps may be skipped, so this is NOT "all steps done".
    const terminalStepNum = Number.isInteger(Number(caseObj.terminal)) ? Number(caseObj.terminal) : (steps.length ? steps[steps.length - 1].step : null);
    let caseComplete = false;
    if (ilead) {
      const nd = new Set(doneSteps);
      for (const s of stepCompleted) nd.add(s);
      caseComplete = terminalStepNum != null && nd.has(terminalStepNum);
    }

    const payload = {
      reply: parsed.reply || 'No response was returned. Please try again.',
      verdict: verdict,
      ilead: ilead,
      completedSteps: stepCompleted,
      caseComplete: caseComplete,
      revealedExhibits: parsed.revealedExhibits,
      exhibits: exhibitCards
    };
    /* Хвост потока несёт ТОТ ЖЕ payload целиком, включая `reply`. Клиент им
       заменяет накопленный текст: разбор маркеров живёт на сервере в одном
       месте (parseMarkers), а поток — только доставка. Если фильтр и парсер
       когда-нибудь разойдутся, побеждает парсер, и расхождение не доедет
       до кандидата. */
    if (sseOpen) { sseSend({ done: 1, payload: payload }); res.end(); return; }
    return res.status(200).json(payload);
  } catch (err) {
    console.error('CasEdge case-session error:', err);
    return res.status(500).json({ error: { message: 'Something went wrong. Please try again.' } });
  }
}
