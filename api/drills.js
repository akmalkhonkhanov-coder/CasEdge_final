// CasEdge — Case Math Drills server endpoint. Owns the curated drill library
// AND all grading, so answer keys / checklists / reference solutions never reach
// the browser. Mirrors api/casey.js security: locked CORS, Supabase bearer
// verification, shared per-user rate limit, body limits, upstream timeout,
// no error leakage.
//
// Actions:
//   next  → {doneIds:[...]} → next unsanitized-of-keys drill in sequence
//           {id,title,difficulty,type,focus,time,prompt,exhibit,step_prompts,index,total}
//   grade → {drillId, answer} → {pass, coaching, reference:{en,ru}, provoked:{en,ru}}

const { verifyUserCached, rateLimitedScoped } = require('./_auth.js');
const { checkAndConsume, refusalMessage, refusalLang } = require('./_entitlements.js');
const DRILLS_CM = require('./_drills_cm.json');
const DRILLS_MS = require('./_drills_ms.json');
const DRILLS_ST = require('./_drills_st.json');
const DRILLS_BR = require('./_drills_br.json');
const DRILLS_CI = require('./_drills_ci.json');
const DRILLS_SY = require('./_drills_sy.json');
// Curated libraries share one endpoint. Client passes set:'ms' (Market Sizing),
// set:'st' (Structuring), set:'br' (Brainstorm), else Case Math. IDs are
// disjoint (CM-*/MS-*/ST-*/BR-*).
// An unknown `set` used to fall through to Case Math silently: a typo in the
// client, or a sixth type shipped before the server knew about it, would serve
// CM drills under a Structuring label and the candidate would never know why.
// Unknown now returns null and the handler answers with an error.
// Null-prototype map on purpose: a plain object literal would answer to
// `set:'toString'` or `set:'__proto__'` with something inherited from
// Object.prototype — truthy, not a function, 500 on the endpoint.
const DRILL_SETS = Object.assign(Object.create(null), {
  cm: () => DRILLS_CM, ms: () => DRILLS_MS, st: () => DRILLS_ST, br: () => DRILLS_BR, ci: () => DRILLS_CI,
  sy: () => DRILLS_SY
});
function libData(body) {
  const s = (body && body.set) || 'cm';
  const get = typeof s === 'string' ? DRILL_SETS[s] : null;
  if (typeof get !== 'function') { console.error('drills: unknown set', JSON.stringify(s).slice(0, 40)); return null; }
  return get();
}

const FALLBACK_ORIGIN = 'https://cas-edge-final.vercel.app';
const GRADER_MODEL = 'claude-sonnet-5';
const MAX_BODY_BYTES = 200 * 1024;
const RATE_LIMIT = 40;
const RATE_WINDOW_MS = 60 * 1000;
const AUTH_TIMEOUT_MS = 8 * 1000;

/* ───────────────────────── telemetry ─────────────────────────────────────── */
// One-line JSON to stdout → Vercel runtime logs. Server-side ONLY: nothing here
// is ever added to a response body, so the candidate never sees tier/echelon.
// Outcomes are logged SEPARATELY and must never be collapsed:
//   grade_pass     — graded, candidate met the checklist
//   grade_fail     — graded, candidate missed it        (a real signal about the drill)
//   grade_unscored — grader hiccup, no verdict rendered (a signal about US, not them)
// Mixing unscored into fail is what makes a drill look "too hard" when the
// grader was simply failing to return JSON.
const crypto = require('crypto');
function userTag(userId) {
  try { return crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 12); }
  catch (e) { return 'anon'; }
}
function logGrade(ev, d, userId, t0, extra) {
  try {
    console.log('CASEDGE_TELEMETRY ' + JSON.stringify({
      ev: ev,                                  // grade_pass | grade_fail | grade_unscored | cull_reveal
      set: (d && d.id || '').split('-')[0].toLowerCase() || null,
      drill: d && d.id || null,
      type: d && d.type || null,
      difficulty: d && d.difficulty || null,   // server-side label; hidden from the candidate
      echelon: !!(d && d.echelon),             // server-side tier flag; hidden from the candidate
      user: userTag(userId),
      ms: t0 ? (Date.now() - t0) : null,          // grader latency
      spent_ms: Number.isFinite(Number(extra && extra.spent_ms)) ? Number(extra.spent_ms) : null,
      ...(extra || {})
    }));
  } catch (e) { /* telemetry must never break a grade */ }
}

// FEEDBACK LANGUAGE (2026-07-25): the three grader prompts hardcode "coaching IN
// ENGLISH". The product lets a candidate run the case in English and take the
// debrief in Russian (fbLang) — understanding your own mistake is easier in your
// own language. This directive overrides the prompt's default for that field only;
// the VERDICT and the rubric are language-independent.
function fbDirective(fbLang) {
  return fbLang === 'ru'
    ? '\n\nFEEDBACK LANGUAGE — OVERRIDES THE FORMAT LINE BELOW/ABOVE: write the `coaching` field in RUSSIAN. Keep every number, unit and proper name exactly as given. Grade by the same standard — the language of the note must not soften the verdict.'
    : '';
}

/* ───────────────────────── grader system prompt ──────────────────────────── */
const DRILL_GRADER_SYSTEM = `You are a strict but fair BCG case-math drill grader. You are given a drill PROMPT, its EXHIBIT data, a PASS CHECKLIST (the exact criteria that must all be met), a reference SOLUTION, and the candidate's ANSWER. Decide pass/fail against the checklist and give 1-2 sentences of coaching. Return ONLY JSON, no preamble, no markdown.

RULES:
1. Pass ONLY if every checklist item is satisfied by the candidate's answer (meaning, not exact wording). Case-math is about the right number AND the right reasoning.
2. Numbers: accept the candidate's number if it matches the checklist target within the stated tolerance (exact unless the checklist says +/-x). Numbers spoken in any form count; ignore currency symbols and thousands separators.
3. This is a TRAP drill family: the checklist usually distinguishes the naive answer from the correct one. If the candidate gives the naive number as their answer, that is a FAIL even if the arithmetic is internally correct.
4. For CLEAN drills the correct move is to confirm no error / no flip — inventing a reversal that is not in the data is a FAIL.
5. Do NOT penalize grammar, spelling, or brevity. Penalize only missing or wrong required content.

RESPONSE FORMAT (strict JSON): {"pass":true,"coaching":"1-2 sentences IN ENGLISH: what was right/missing and the one thing to fix. Specific, cite the key number."}`;

// Structuring (ST) is qualitative — there is no single number. It is graded on
// five registers: COVER (required branches, judged by MEANING not label), DECOY
// (reflexive branches that must NOT be developed first), ME (branch pairs that
// cannot stand together), DRIVE (what to measure), ORDER (defensible starting
// branch). There is NO canonical tree — many MECE trees are valid; the only
// objective failure is a MISSING required branch (per the casebook grounding).
const ST_GRADER_SYSTEM = `You are a strict but fair MBB structuring-drill grader. The candidate was given an anchor question and asked to build a MECE issue tree — NOT to solve the case. You are given the grading REGISTERS (the answer key) and the candidate's TREE. Return ONLY JSON, no preamble, no markdown.

HOW TO GRADE (in priority order):
1. COVER is the core. Every required branch must be present in the candidate's tree BY MEANING — accept synonyms and rephrasings, never demand the exact label. A tree that MISSES a required branch FAILS, no matter how clean the rest is. This is the one objective failure mode.
2. DECOY: mentioning a decoy branch is NOT penalised. It fails ORDER only if the candidate makes a decoy their FIRST branch to develop / their lead hypothesis.
3. ME: the matrix flags pairs that must not be merged. FAIL only on the status the library actually writes as hard: **direct violation**. Every other status it writes — partial, absorption, conflation risk, duplicate, shared, opposition — is a WARNING, never a fail. The pair may be decoy-to-branch or branch-to-branch; in this library the hard marks sit on decoy-to-branch. Do not invent a status: if the pair carries no status you were given, it is not a fail.
4. ORDER: a defensible start is any branch justified by a real criterion (size of effect, speed to check, cost of data). Starting on a decoy is an ORDER defect. Not stating any criterion is a coaching note, not a fail.
5. DRIVE: for each branch the key names WHAT WOULD BE MEASURED under it. A branch stated as a heading with nothing measurable under it is a coaching note — name the metric the candidate should have put there. DRIVE never decides pass/fail on its own.
6. Do NOT reward tree LENGTH or generic templates (e.g. a blank "profitability = revenue − cost" with no tailoring). Reward branches tailored to THIS company and question.

PASS = all COVER branches present (by meaning) AND no decoy developed first AND no hard ME violation.

RESPONSE FORMAT (strict JSON): {"pass":true,"coaching":"1-2 sentences IN ENGLISH: name which required branch (if any) was missed, or the decoy/ME slip, and the single most valuable fix. Be specific to this case."}`;

// Brainstorm (BR) — creativity/idea-generation. The candidate produces a flat list
// of options for a case question. Graded on registers, NOT on volume:
//   LOAD  = the one load-bearing idea; if it is missing the slot FAILS regardless.
//   COVER = required axes (2–4); fewer than 2 axes covered = FAIL.
//   DEAD  = reflexive branches the slot's facts kill; naming one FIRST or SECOND
//           without dismissing it = an ORDER defect (FAIL). Naming it later, or
//           naming + dismissing it with a reason, is fine.
//   GATE-3 = fewer than 3 fact-linked ideas = FAIL.
// The answer key (LOAD/COVER/DEAD, and the CULL kill-set) is written in RUSSIAN;
// the candidate answers in ENGLISH. MATCH BY MEANING across languages — never
// require the Russian wording. Volume never earns credit.
// Two-move CULL slots: after the idea list, the candidate is shown the client
// team's idea list + a NEW FACT and must name exactly which team ideas the fact
// KILLS, with a reason. The kill-set must match the reference EXACTLY (an extra
// kill fails as hard as a miss); each kill needs a correct, distinct reason.
const BR_GRADER_SYSTEM = `You are a strict but fair MBB brainstorm/creativity-drill grader. You receive the case QUESTION, the FACTS given to the candidate, the grading REGISTERS (answer key: LOAD, COVER, DEAD — written in Russian), and the candidate's IDEA LIST (written in English). If a CULL block is present you also receive the client team's ideas, the new fact, the reference KILL-SET, and the candidate's CULL answer. Return ONLY JSON, no preamble, no markdown.

MATCH BY MEANING across languages: the key is Russian, the answer English — accept any idea/branch that means the same thing; never demand the Russian wording.

GRADE IN THIS ORDER (all applicable gates must pass):
1. GATE-3: at least 3 ideas that are genuinely tied to the slot's facts. Fewer → FAIL.
2. LOAD (gate): the load-bearing idea must be present by meaning. Missing → FAIL no matter how long the list.
3. DEAD-ORDER: if the candidate leads with a DEAD branch (their 1st or 2nd idea) and does NOT dismiss it, that is an ORDER defect → FAIL. A DEAD branch named later, or named and explicitly dismissed with a valid reason, is NOT a defect.
4. COVER: at least 2 of the required axes must be covered by meaning. Fewer → FAIL.
5. VOLUME EARNS NOTHING: do not reward a longer list. Six ideas and three ideas with the same coverage and LOAD named score identically.
5b. FIGURES: if an idea rests on a number that contradicts the FACTS — wrong by an order of magnitude, a share above 100%, a quantity larger than the stock it is drawn from — name it in the coaching. This is NOT a gate: this drill grades the generation of ideas, not arithmetic. Do not fail an otherwise covering list for it.
6. CULL (only if a CULL block is present): the candidate must name EXACTLY the reference kill-set (by meaning of which team ideas die), each with a correct and distinct reason. An extra kill fails as hard as a miss; a wrong reason on any kill = FAIL.

PASS = every applicable gate passes.

RESPONSE FORMAT (strict JSON): {"pass":true,"coaching":"1-2 sentences IN ENGLISH: name the missing LOAD / uncovered axis / DEAD-order slip / CULL miss, and the single most valuable fix. Be specific to this case.","model":"1-2 sentences IN ENGLISH stating the load-bearing idea and the axes a strong answer covers — the takeaway. Never output Russian."}`;

/* ───────────────────────── library ───────────────────────────────────────── */
let _byId = null;
function drillById(id) {
  // one combined map across all libraries — ids are disjoint (CM-*/MS-*/ST-*)
  if (!_byId) { _byId = new Map(); for (const src of [DRILLS_CM, DRILLS_MS, DRILLS_ST, DRILLS_BR, DRILLS_CI, DRILLS_SY]) for (const d of (src.drills || [])) _byId.set(d.id, d); }
  return _byId.get(id);
}

// Client-safe view: prompt / exhibit / step prompts / meta — NO checklist,
// reference, provoked, key registers, or step answers.
// ST drills: the `key` registers (COVER/ME/DRIVE/ORDER/DECOY), anchor_metric and
// reference are server-only. For E-after drills the exhibit itself is WITHHELD
// until the candidate has submitted a tree (revealed=true) — the whole point is
// that the data breaks the framework they already built.
function sanitizeDrill(d, index, total, revealed) {
  // Brainstorm (BR): qualitative idea-generation. Client sees prompt + facts. The
  // `key` (LOAD/COVER/DEAD/grader) is server-only. CULL slots are two-move: the
  // client team's idea list + the new fact are WITHHELD until the candidate has
  // submitted their own idea list (revealed only in the grade response). NO exhibits.
  if (d.type === 'Brainstorm') {
    return {
      id: d.id, title: d.title, type: d.type,   // difficulty (tier) withheld — see NO-SPOILER note below
      company: d.company || null, industry: d.industry || null, time: d.time,
      prompt: d.prompt, facts: d.facts || [],
      cull: !!d.cull,            // client shows a 2nd-move ("cull") screen when true
      index: index, total: total
    };
  }
  const isAfter = d.exhibit_mode === 'E-after';
  const exhibit = (isAfter && !revealed) ? null : (d.exhibit || null);
  // NO-SPOILER (2026-07-25): `difficulty` (tier) and `focus` are NOT sent. focus
  // names the trap mechanism outright ("F05(A) PERPETUITY VS DECAY") and tier
  // primes the candidate — both used to render as chips above the prompt. `type`
  // still ships because the client branches on Structuring/Brainstorm, but it is
  // no longer displayed.
  // NO-SPOILER, second pass (2026-07-26): `type` on CM/MS carries the literal
  // values 'Trap' / 'Clean'. Shipping it told the candidate, on every single
  // slot, whether a trap is present at all — a bigger giveaway than the tier and
  // focus chips already withheld above. The client only ever compares type
  // against 'Structuring' and 'Brainstorm', so everything else goes out as a
  // neutral branch token. The trim also kills stray markdown in the data
  // ('**Clean**' in 5 CM slots), which would otherwise defeat any type match.
  const branch = String(d.type || '').replace(/[*_`~]/g, '').trim() === 'Structuring'
    ? 'Structuring' : 'Drill';
  return {
    id: d.id, title: d.title, type: branch,
    time: d.time,
    prompt: d.prompt,
    exhibit: exhibit,
    exhibit_mode: d.exhibit_mode || null,   // client gates the E-after flow on this
    exhibit_withheld: (isAfter && !revealed) || false,
    step_prompts: d.step_prompts || [],
    index: index, total: total
  };
}

function nextDrill(doneIds, data) {
  const done = new Set(Array.isArray(doneIds) ? doneIds : []);
  const list = (data || DRILLS_CM).drills || [];
  const idx = list.findIndex(d => !done.has(d.id));
  if (idx < 0) return null;                 // all done
  return sanitizeDrill(list[idx], idx + 1, list.length);
}

/* ───────────────────────── infra (shared pattern) ────────────────────────── */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RETRIABLE_STATUS = new Set([429, 500, 502, 503, 529]);
// `deadlineAt` (ms epoch) bounds the WHOLE retry sequence. Without it, retries
// multiply the per-attempt timeout — 3 x 45s would blow the 60s function limit
// and turn a soft "could not grade, try again" into a hard gateway timeout.
// Each attempt is clamped to whatever time is left, and a retry is only started
// if a meaningful attempt still fits.
const MIN_ATTEMPT_MS = 8000;
async function fetchAnthropicWithRetry(url, options, timeoutMs, maxRetries, deadlineAt) {
  let lastErr, lastResp;
  const left = () => (deadlineAt ? deadlineAt - Date.now() : Infinity);
  // The guard is on TIME LEFT, never on the caller's per-attempt timeout: a
  // caller that legitimately asks for short attempts must still get its retries.
  const room = () => Math.min(timeoutMs, Math.max(0, left()));
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const back = Math.min(700 * Math.pow(2, attempt - 1), 4000);
      if (left() < back + Math.min(MIN_ATTEMPT_MS, timeoutMs)) break;
      await sleep(back);
    }
    const budget = room();
    if (attempt > 0 && budget < Math.min(MIN_ATTEMPT_MS, timeoutMs)) break;
    try {
      const resp = await fetchWithTimeout(url, options, budget || timeoutMs);
      lastResp = resp;
      if (RETRIABLE_STATUS.has(resp.status) && attempt < maxRetries) continue;
      return resp;
    } catch (e) { lastErr = e; if (attempt >= maxRetries) break; }
  }
  if (lastResp) return lastResp;
  if (lastErr) throw lastErr;
  throw new Error('upstream unavailable');
}
async function rateLimited(userId, sbUrl, sbKey, token) {
  /* Ключ счётчика разведён по ручкам — см. api/_auth.js. До этого все
     восемь ручек делили одну строку, и порог 6 у транскрипции вместе
     с окном 300 секунд действовал на всех. */
  return rateLimitedScoped({ userId, scope: 'drills', limit: RATE_LIMIT,
    windowSeconds: RATE_WINDOW_MS / 1000, sbUrl, sbKey, token, timeoutMs: AUTH_TIMEOUT_MS });
}

// One bounded model call + a single truncation retry inside a hard deadline.
async function graderJSON(system, userText, maxTokens) {
  const T0 = Date.now();
  const BUDGET_MS = 52 * 1000;
  /* УПРАВЛЕНИЕ РАЗМЫШЛЕНИЕМ У ГРЕЙДЕРА.
     Замер на проде 07.08: разбор дрилла отдаётся за 7.7-9.2 секунды при выходе
     624-700 токенов. Видимый разбор — это полторы сотни слов, то есть примерно
     200 токенов; остальные 400-500 уходят в размышление, которым здесь никто
     не управлял. В case-session лесенка режимов стоит с 29.07 и работает,
     в грейдере дриллов её просто не было.
     Ставим ту же лесенку: adaptive+effort:low → adaptive → без управления,
     со спуском по отказу апстрима. Меньше скрытых токенов — быстрее ответ
     кандидату и дешевле ход. Качество разбора это не трогает: чек-лист,
     эталон и правила остаются те же, меняется бюджет размышления. */
  const MODES = [
    { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } },
    { thinking: { type: 'adaptive' } },
    null
  ];
  let _mode = 0;
  const call = (mt, timeoutMs) => fetchAnthropicWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31'
    },
    // Системный блок разбора одинаков для всего набора и переезжает по сети
    // на каждую проверку. Помечаем его кешем: содержание не меняется, значит
    // платить за него как за новый вход незачем. На качество не влияет вовсе —
    // модель получает тот же текст, меняется только цена его доставки.
    // (Блоки короче 1024 токенов апстрим просто не кеширует, и это безопасно:
    // пометка на коротком блоке ничего не ломает, она молча не срабатывает.)
    body: JSON.stringify(Object.assign({ model: GRADER_MODEL, max_tokens: mt,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userText }] }, MODES[_mode] || {}))
    // maxRetries was 0 here, which made the whole RETRIABLE_STATUS branch in
    // fetchAnthropicWithRetry dead code (`attempt < maxRetries` is never true at
    // 0). A 429/529 from upstream came straight back and was then treated as
    // "the model wrote bad JSON". Two attempts with backoff is what the helper
    // was written for.
  }, timeoutMs, 2, T0 + BUDGET_MS);
  const textOf = dd => (dd && Array.isArray(dd.content)) ? dd.content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
  const parse = t => { try { const m = String(t || '').match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; } catch (e) { return null; } };
  let resp = await call(maxTokens, 45 * 1000);
  /* Спуск по лесенке: апстрим отвергает форму — пробуем следующую, но только
     если он жалуется именно на управление размышлением. Иначе это не наш случай
     и повтор только тратит бюджет. */
  while (resp && resp.status === 400 && _mode < MODES.length - 1) {
    const txt = await resp.clone().text().catch(() => '');
    if (!/thinking|output_config|effort/i.test(txt)) break;
    console.error('drills grader: mode', _mode, 'rejected -', txt.slice(0, 140));
    _mode++;
    resp = await call(maxTokens, 45 * 1000);
  }
  // The first response's status was never checked: an error body has no
  // `content` array, so textOf() returned '' and parse('') returned null — a
  // transport failure and an unparseable answer were the same event. They need
  // opposite responses, so they are separated here.
  if (resp.status < 200 || resp.status >= 300) {
    let body = '';
    try { body = JSON.stringify(await resp.json()).slice(0, 300); } catch (e) { /* keep */ }
    console.error('drills grader upstream non-2xx', resp.status, body);
    return null;                       // do NOT re-ask with double max_tokens
  }
  let data = await resp.json();
  /* Расход разбора не логировался вовсе: телеметрия писала только ms, поэтому
     на вопрос «сколько стоит дрилл» ответа не существовало. Пишем то же, что
     пишет case-session, и теми же именами, чтобы два эндпоинта считались одним
     запросом к логам. Имени дрилла тут нет намеренно: в graderJSON его в
     области видимости не существует, и первая версия этой строки ссылалась на
     несуществующую переменную — то есть падала бы на каждом разборе. Дрилл
     виден в соседней строке CASEDGE_TELEMETRY того же запроса. */
  if (data && data.usage) {
    const u = data.usage;
    console.log('drills usage', JSON.stringify({
      in: u.input_tokens, out: u.output_tokens,
      cache_read: u.cache_read_input_tokens, cache_write: u.cache_creation_input_tokens,
      stop: data.stop_reason, mode: _mode, ms: Date.now() - T0 }));
  }
  let parsed = parse(textOf(data));
  // Retry once inside the deadline on truncation OR unparseable output. This
  // path is for a MODEL problem only — doubling max_tokens against a rate limit
  // makes the rate limit worse, which is why the non-2xx case returns above.
  const needsRetry = !parsed || (data && data.stop_reason === 'max_tokens');
  const timeLeft = BUDGET_MS - (Date.now() - T0);
  if (needsRetry && timeLeft > 12 * 1000) {
    try { const r2 = await call(Math.min(maxTokens * 2, 2000), timeLeft - 2000); if (r2.status === 200) { const d2 = await r2.json(); const p2 = parse(textOf(d2)); if (p2) parsed = p2; } } catch (e) { /* keep */ }
  }
  if (!parsed) console.error('drills grader unparseable after retry', String(textOf(data) || '').slice(0, 200));
  return parsed;
}

// Brainstorm (BR): grade the idea list (and, for CULL slots, the cull answer) by
// meaning against LOAD/COVER/DEAD (+ kill-set). `cullAnswer` is null on single-move
// (non-CULL) slots and on the interim move-1 reveal.
async function gradeBR(d, answer, cullAnswer, fbLang) {
  const k = d.key || {};
  let u = 'CASE QUESTION: ' + d.prompt +
    '\n\nFACTS GIVEN TO CANDIDATE:\n- ' + (d.facts || []).join('\n- ') +
    '\n\n--- GRADING REGISTERS (answer key, RUSSIAN — match by meaning) ---' +
    '\nLOAD (load-bearing idea, gate):\n' + (k.load || '') +
    '\n\nCOVER (required axes, ≥2):\n' + (k.cover || '') +
    '\n\nDEAD (branches the facts kill):\n' + (k.dead || '') +
    '\n\nGRADER SYNONYMS:\n' + (k.grader || '') +
    '\n\n--- CANDIDATE IDEA LIST ---\n' + String(answer || '');
  if (d.cull && k.cull && cullAnswer != null) {
    const c = k.cull;
    u += '\n\n--- SECOND MOVE (CULL) ---' +
      '\nNEW FACT shown to candidate: ' + (c.new_fact || '') +
      '\nCLIENT TEAM IDEAS (numbered):\n' + (c.team_ideas || []).map((t, i) => (i + 1) + '. ' + t).join('\n') +
      '\nREFERENCE KILL-SET (team-idea numbers that the new fact kills): {' + (c.killed || []).join(', ') + '}' +
      '\nPER-IDEA REFERENCE + reasons:\n' + (c.peridea_raw || '') +
      '\n\n--- CANDIDATE CULL ANSWER (which team ideas die + why) ---\n' + String(cullAnswer || '');
  }
  const j = await graderJSON(BR_GRADER_SYSTEM, u + fbDirective(fbLang), 800);
  return j || { graded: false, coaching: 'Could not grade — please try again.' };
}

// CI (Chart Interpretation): the skill is reading an exhibit, not arithmetic.
// A candidate who restates the chart correctly has done nothing — the pass is
// the ONE insight, its business implication and the next check. The checklist
// is the contract; the reference is the model answer.
const CI_GRADER_SYSTEM = `You are a strict but fair MBB chart-interpretation drill grader. You receive the drill PROMPT, the EXHIBIT (tables, drawn charts and footnotes), a PASS CHECKLIST (the exact criteria, all of which must be met), a reference SOLUTION, and the candidate's ANSWER. Return ONLY JSON, no preamble, no markdown.

GRADE THE READING, NOT THE PROSE. Describing what the chart shows is not an insight. Pass requires: the load-bearing insight named, the business implication stated, and — where the checklist asks for it — the next check or the number that settles it.
A candidate who reaches the same insight by a different route PASSES. A candidate who lands on the naive reading the exhibit is built to provoke FAILS, however fluent the writing.
Never invent a number that is not in the exhibit. If the candidate quotes a number that is not there, that is a fail with the reason named.

Return: {"pass": boolean, "coaching": "1-2 sentences naming what was missed or what was strong"}`;

// SY (Synthesis): the candidate reads someone else's record and delivers a
// verdict. The skill graded here is Minto, and it is graded FIRST: a correct
// conclusion built up to at the end is a fail, because on the interview the
// partner has stopped listening by then. The `key` registers (naive, decoy,
// support, risks, next, build) are server-only.
const SY_GRADER_SYSTEM = `You are a strict but fair MBB synthesis drill grader. You receive the drill PROMPT, the RECORD the candidate had to read, an answer KEY (the naive read the record provokes, the decoy fact, the facts that actually carry the answer, the risks, the next step), a PASS CHECKLIST (every item must be met), a reference SOLUTION, and the candidate's ANSWER. Return ONLY JSON, no preamble, no markdown.

CONCLUSION FIRST IS A HARD GATE. The candidate's first sentence must BE the recommendation - an action verb with a subject ("We recommend X", "BuildCo should Y"). A correct conclusion that arrives after the supporting facts FAILS, and the coaching must say so in those words. This is the single most expensive habit on a real interview and it is not negotiable here.
Then: does the answer name the figure that decides it? Does it drop, or explicitly set aside, the decoy the record is built around? Does it carry at least the risks and next step the checklist asks for?
A candidate who reaches the same verdict by a different route PASSES. A candidate who lands on the naive read PASSES NOTHING, however fluent.

FIGURES MUST AGREE WITH THE RECORD. Check every number the candidate states against the RECORD above. A figure that contradicts the record — wrong by an order of magnitude, a share above 100%, a quantity larger than the stock it is drawn from — is a defect and must be named in the coaching. When the contradicting figure is the one the recommendation RESTS ON, that is a FAIL: naming the deciding figure is the point of this drill, and a deciding figure that cannot be true names nothing. A stray slip in a supporting sentence is a coaching note, not a fail.
You yourself must never invent a number that is not in the record.

Return: {"pass": boolean, "coaching": "1-2 sentences naming what was missed or what was strong"}`;

/* ─────────────────── СЛУЖЕБНЫЕ БЛОКИ ЦЕХА В ЭТАЛОНЕ ────────────────────────
   24.08.2026, находка цеха дриллов. `reference` возвращается кандидату ДОСЛОВНО
   после каждой оценённой попытки, и вместе с решением он читал внутренние
   блоки цеха. Замер по боевым мастерам: 206 вхождений в пяти библиотеках
   из шести — [DUP] (спор «не близнец ли слот»), [BUILD] (доказательство
   собранного числа, вместе с питоновским кодом), [TWO LEVERS], [ONE LEVER].

   Правило РАЗНОЕ, потому что классы разные, и это видно по материалу:
     · [DUP] и [BUILD] — сам ТЕКСТ внутренний. Режем абзац целиком, вместе
       с прилипшим блоком кода.
     · [TWO LEVERS] и [ONE LEVER] — текст ПОЛЕЗНЫЙ (разбор чувствительности),
       внутренний только ярлык. Снимаем ярлык, текст остаётся.

   Материал правит цех — это их 103 места. Здесь СЕТЬ: движок не должен
   зависеть от того, что цех никогда не оступится. Тот же принцип, что
   у scrubPrompt в Redrock. */
const REF_INTERNAL = /\[(?:DUP|BUILD)\]/;
const REF_LABEL = /\*{0,2}\[(?:TWO LEVERS|ONE LEVER)\]\*{0,2}\s*/g;
function refBlocks(s) {
  // абзацы, но огороженный блок кода — ОДИН неделимый кусок
  const out = []; let pos = 0;
  const fence = /```[\s\S]*?```/g; let m;
  while ((m = fence.exec(s)) !== null) {
    for (const p of s.slice(pos, m.index).split('\n\n')) out.push(p);
    out.push(m[0]); pos = m.index + m[0].length;
  }
  for (const p of s.slice(pos).split('\n\n')) out.push(p);
  return out;
}
/* 25.08.2026, dev. Дыра, найденную цехом дриллов в круге 84 и подтверждённую
   их прогоном: блок [DUP] состоит из ТРЁХ кусков — заголовок, markdown-таблица
   сравнения с чужими слотами, хвост «In (a)…». Правило перешагивало ограду
   кода и НЕ перешагивало таблицу, поэтому кандидат получал голую таблицу,
   сравнивающую его слот с ST-010 и ST-020, которых он не видел.
   Материал цех уже почистил; сеть чинится здесь, чтобы следующий такой блок
   не проехал наполовину. Хвост глотается ТОЛЬКО если была таблица и следующий
   кусок не список и не заголовок — иначе съелся бы полезный разбор. */
function refIsTable(p) {
  const ls = String(p).split('\n').map(x => x.trim()).filter(Boolean);
  return ls.length >= 2 && ls.every(l => l.startsWith('|'));
}
function refStartsList(p) {
  return /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>)/.test(String(p));
}
function scrubReference(v) {
  if (typeof v !== 'string' || !v) return v;
  const parts = refBlocks(v);
  const keep = [];
  for (let i = 0; i < parts.length;) {
    if (REF_INTERNAL.test(parts[i])) {
      i++;
      // пустые куски между абзацем и блоком кода — артефакт нарезки
      let j = i; while (j < parts.length && parts[j].trim() === '') j++;
      while (j < parts.length && parts[j].trimStart().startsWith('```')) {
        i = j + 1; j = i;
        while (j < parts.length && parts[j].trim() === '') j++;
      }
      let ate = false;
      if (j < parts.length && refIsTable(parts[j])) {
        i = j + 1; ate = true; j = i;
        while (j < parts.length && parts[j].trim() === '') j++;
      }
      if (ate && j < parts.length && parts[j].trim() &&
          !refStartsList(parts[j]) && !refIsTable(parts[j])) {
        i = j + 1;
      }
      continue;
    }
    keep.push(parts[i]); i++;
  }
  return keep.join('\n\n').replace(REF_LABEL, '').replace(/\n{3,}/g, '\n\n').trim();
}
function scrubReferencePair(r) {
  if (!r || typeof r !== 'object') return r;
  return { en: scrubReference(r.en || ''), ru: scrubReference(r.ru || '') };
}

async function gradeDrill(d, answer, fbLang) {
  if (d.type === 'Synthesis') {
    const k = d.key || {};
    const u = 'PROMPT: ' + d.prompt +
      '\nRECORD: ' + JSON.stringify(d.exhibit || {}) +
      '\n\n--- ANSWER KEY (server-only) ---' +
      '\nNAIVE READ: ' + (k.naive || '') +
      '\nDECOY: ' + (k.decoy || '') +
      '\nSUPPORT: ' + (k.support || '') +
      '\nRISKS: ' + (k.risks || '') +
      '\nNEXT STEP: ' + (k.next || '') +
      '\n\nPASS CHECKLIST: ' + (d.checklist && (d.checklist.en || d.checklist.ru) || '') +
      '\nREFERENCE SOLUTION: ' + (d.reference && (d.reference.en || d.reference.ru) || '') +
      '\nCANDIDATE ANSWER: ' + String(answer || '');
    const j = await graderJSON(SY_GRADER_SYSTEM, u + fbDirective(fbLang), 900);   // 700 упиралось в потолок: повтор стоил +7.5 с
    return j || { graded: false, coaching: 'Could not grade — please try again.' };
  }
  // CI: exhibit is a `parts` sequence, not header/rows — serialise it whole.
  if (d.type === 'Chart Interpretation') {
    const u = 'PROMPT: ' + d.prompt +
      '\nEXHIBIT: ' + JSON.stringify(d.exhibit || {}) +
      '\nPASS CHECKLIST: ' + (d.checklist && (d.checklist.en || d.checklist.ru) || '') +
      '\nREFERENCE SOLUTION: ' + (d.reference && (d.reference.en || d.reference.ru) || '') +
      '\nCANDIDATE ANSWER: ' + String(answer || '');
    const j = await graderJSON(CI_GRADER_SYSTEM, u + fbDirective(fbLang), 700);
    return j || { graded: false, coaching: 'Could not grade — please try again.' };
  }
  // ST (Structuring): grade the candidate's tree against the five registers.
  if (d.type === 'Structuring' && d.key) {
    const k = d.key;
    const exhibitTxt = d.exhibit ? ('EXHIBIT (visible to candidate for this grade):\n' + JSON.stringify({ header: d.exhibit.header, rows: d.exhibit.rows })) : 'EXHIBIT: none / withheld';
    const u = 'ANCHOR QUESTION: ' + d.prompt +
      '\n\n--- GRADING REGISTERS (answer key) ---' +
      '\nCOVER (required branches):\n' + (k.cover || '') +
      '\n\nDECOY (reflexive branches — must not lead):\n' + (k.decoy || '') +
      '\n\nME (incompatible pairs):\n' + (k.me || '') +
      /* 23.08.2026, dev. Находка цеха дриллов: регистр DRIVE объявлен в комментарии
         выше и заполнен у 49 слотов из 50, но до грейдера не доходил ВООБЩЕ.
         Дерево из одних заголовков проходило так же, как дерево с метриками.
         Отдаём регистр грейдеру, но УСЛОВИЕ PASS НЕ МЕНЯЕМ: иначе сложность
         50 слотов сдвинется одним ходом и без замера. */
      '\n\nDRIVE (what to measure under each branch):\n' + (k.drive || '') +
      '\n\nORDER (defensible starts):\n' + (k.order || '') +
      '\n\n' + exhibitTxt +
      '\n\n--- CANDIDATE TREE ---\n' + String(answer || '');
    const j = await graderJSON(ST_GRADER_SYSTEM, u + fbDirective(fbLang), 800);
    // graderJSON null = the model didn't return parseable JSON. Return graded:false
    // (NEUTRAL) rather than pass:false so a grader hiccup is not shown as a candidate FAIL.
    return j || { graded: false, coaching: 'Could not grade — please try again.' };
  }
  const exhibitTxt = d.exhibit ? ('EXHIBIT ' + JSON.stringify({ header: d.exhibit.header, rows: d.exhibit.rows })) : 'EXHIBIT: none';
  const u = 'PROMPT: ' + d.prompt +
    '\n' + exhibitTxt +
    '\nSTEPS ASKED: ' + (d.step_prompts || []).join(' | ') +
    '\nPASS CHECKLIST: ' + (d.checklist && d.checklist.en || '') +
    '\nREFERENCE SOLUTION: ' + (d.reference && d.reference.en || '') +
    '\nCANDIDATE ANSWER: ' + String(answer || '');
  const j = await graderJSON(DRILL_GRADER_SYSTEM, u + fbDirective(fbLang), 600);
  return j || { graded: false, coaching: 'Could not grade — please try again.' };
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
    const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: { message: 'Authentication required.' } });
    const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_ANON_KEY;
    if (!sbUrl || !sbKey) return res.status(500).json({ error: { message: 'Server auth not configured.' } });

    const raw = JSON.stringify(req.body || {});
    if (raw.length > MAX_BODY_BYTES) return res.status(413).json({ error: { message: 'Request too large.' } });

    // Одна проверка сессии на всё приложение — ./_auth.js, с кешем на инстанс.
    // Раньше каждый вызов ходил в /auth/v1/user по сети; на тёплом инстансе
    // повторная проверка того же токена теперь не идёт в сеть вовсе.
    const user = await verifyUserCached(token, AUTH_TIMEOUT_MS);
    if (!user) return res.status(401).json({ error: { message: 'Invalid or expired session.' } });
    const userId = user.id;

    const body = req.body || {};

    if (body.action === 'list' || body.action === 'next') {
      const lib = libData(body);
      if (!lib) return res.status(400).json({ error: { message: 'Unknown drill set.' } });
      if (body.action === 'list') {
        // difficulty/focus withheld here too — otherwise one `list` call hands over
        // the tier and trap mechanism of every drill in the set.
        return res.status(200).json({ drills: (lib.drills || []).map(d => ({ id: d.id, title: d.title })) });
      }
      return res.status(200).json({ drill: nextDrill(body.doneIds, lib) });   // null when the set is exhausted
    }
    if (body.action === 'grade') {

    /* 23.08.2026, dev. ПУСТОЙ ХОД. Клиент отправлял пустую строку, и она шла
       ДАЛЬШЕ: право списывалось, модель звалась, кандидат получал разбор
       на ничто. Отбой стоит ДО checkAndConsume и ДО любого обращения к модели —
       иначе пустой ход стоит попытки. */
    {
      const stage = body.stage === 'cull';
      const said = stage ? body.answer : (body.answer != null ? body.answer : body.move1Answer);
      if (said == null || String(said).trim() === '') {
        return res.status(400).json({ error: { message: 'Empty answer.', code: 'empty_answer' } });
      }
    }

    /* ПРАВА. Списываем ПОСЛЕ того, как человек начал работать, и ровно один раз
       на дрилл: ключ расхода идемпотентен, поэтому обрыв связи, перезагрузка
       и повтор того же хода попытку не съедают. Сбой базы пускает (решение
       владельца 09.08.2026) и печатает строку в лог. */
    {
      const ent = await checkAndConsume({ kind: 'drills', ref: 'drill:' + String(body.drillId), sbUrl, sbKey, token });
      if (!ent.allowed) return res.status(402).json({
        error: { message: refusalMessage('drills', refusalLang(body)), code: 'entitlement_exhausted' },
        entitlement: { kind: 'drills', remaining: 0, cap: ent.cap, used: ent.used }
      });
    }
      const d = drillById(body.drillId);
      if (!d) return res.status(400).json({ error: { message: 'Unknown drill.' } });
      // client sends its resolved feedback language; anything but 'ru' means English
      const fbLang = body.fbLang === 'ru' ? 'ru' : 'en';
      // how long the candidate actually took (soft timer, client-reported).
      // Bounded: a bad client must not be able to write junk into the logs.
      const spentMs = Number.isFinite(Number(body.elapsedMs)) && Number(body.elapsedMs) >= 0
        ? Math.min(Number(body.elapsedMs), 4 * 60 * 60 * 1000) : null;

      // Brainstorm two-move CULL: MOVE 1 reveals the client team's ideas + the new
      // fact (no grading, no LLM, no rate-limit) so the fact can break the list the
      // candidate just built. The candidate then submits the CULL answer (stage:'cull').
      if (d.type === 'Brainstorm' && d.cull && body.stage !== 'cull') {
        const c = (d.key && d.key.cull) || {};
        logGrade('cull_reveal', d, userId, null);
        return res.status(200).json({
          stage: 'cull',
          cull: { new_fact: c.new_fact || '', team_ideas: c.team_ideas || [] },
          move1Answer: String(body.answer || '')   // echoed back so the client returns it with the cull move
        });
      }

      if (await rateLimited(userId, sbUrl, sbKey, token)) {
        return res.status(429).json({ error: { message: 'Too many requests. Please slow down.' } });
      }

      // Brainstorm final grade: single-move slots grade the idea list; CULL slots
      // grade the idea list (move1Answer) + the cull answer together in one call.
      if (d.type === 'Brainstorm') {
        const ideaList = d.cull ? body.move1Answer : body.answer;
        const cullAns = d.cull ? body.answer : null;
        const t0 = Date.now();
        const rb = await gradeBR(d, ideaList, cullAns, fbLang);
        if (rb && rb.graded === false) {
          logGrade('grade_unscored', d, userId, t0, { stage: d.cull ? 'cull' : 'single', spent_ms: spentMs });
          return res.status(200).json({ graded: false, coaching: rb.coaching || 'Could not grade — please try again.' });
        }
        logGrade(rb.pass ? 'grade_pass' : 'grade_fail', d, userId, t0, { stage: d.cull ? 'cull' : 'single', spent_ms: spentMs });
        // РАЗБОР BR. Раньше сюда уходил ТОЛЬКО ответ модели (rb.model): текст,
        // который никем не проверен и на каждом прогоне другой. Теперь источник —
        // поле `reference` слота, а модель остаётся страховкой, пока цех дриллов
        // дописывает поле по всем сорока девяти. Строка в лог помечает слоты,
        // где поля ещё нет: по ней видно остаток конверсии.
        const brRef = (d.reference && (d.reference.en || d.reference.ru)) ? d.reference : null;
        if (!brRef) console.log('drills br_reference_missing', d.id);
        return res.status(200).json({
          pass: !!rb.pass,
          coaching: rb.coaching || '',
          reference: scrubReferencePair(brRef) || { en: rb.model || '', ru: '' }
        });
      }

      const t0 = Date.now();
      const r = await gradeDrill(d, body.answer, fbLang);
      // grader hiccup → tell the client to let the candidate retry, NOT mark it failed/done.
      if (r && r.graded === false) {
        logGrade('grade_unscored', d, userId, t0, { spent_ms: spentMs });
        return res.status(200).json({ graded: false, coaching: r.coaching || 'Could not grade — please try again.' });
      }
      logGrade(r.pass ? 'grade_pass' : 'grade_fail', d, userId, t0, { spent_ms: spentMs });
      // ST E-after: reveal the exhibit only now (after the tree is submitted), so
      // the candidate can see how the data breaks their framework, then refine.
      const revealExhibit = (d.type === 'Structuring' && d.exhibit_mode === 'E-after' && d.exhibit) ? d.exhibit : null;
      return res.status(200).json({
        pass: !!r.pass,
        coaching: r.coaching || '',
        reference: scrubReferencePair(d.reference) || { en: '', ru: '' },
        provoked: d.provoked || { en: '', ru: '' },
        exhibit: revealExhibit,
        exhibit_mode: d.exhibit_mode || null
      });
    }

    return res.status(400).json({ error: { message: 'Unknown action.' } });
  } catch (err) {
    console.error('CasEdge Drills error:', err);
    return res.status(500).json({ error: { message: 'Something went wrong. Please try again.' } });
  }
}
