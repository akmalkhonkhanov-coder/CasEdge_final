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
const CASES_DATA = require('./_cases.json');

const FALLBACK_ORIGIN = 'https://cas-edge-final.vercel.app';
const CASE_MODEL = 'claude-sonnet-5';   // fixed server-side; client cannot choose
const MAX_TOKENS = 1300;
const MAX_BODY_BYTES = 200 * 1024;      // 200 KB request cap
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
  return data.cases.map(c => ({
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

export function levelToBand(level) {
  const n = Number(level);
  if (!Number.isFinite(n)) return 'Medium';   // no history yet → start in the middle
  if (n < 5) return 'Easy';
  if (n < 7.5) return 'Medium';
  return 'Hard';
}

const BAND_FALLBACK = {
  Easy: ['Easy', 'Medium', 'Hard'],
  Medium: ['Medium', 'Easy', 'Hard'],
  Hard: ['Hard', 'Medium', 'Easy']
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
  const pool = data.cases.filter(c => typeMatchServer(c.case_type, caseType) && !seen.has(Number(c.id)));
  if (!pool.length) {
    const anyUnseen = data.cases.some(c => !seen.has(Number(c.id)));
    return { exhausted: true, scope: anyUnseen ? 'type' : 'all' };
  }
  const band = levelToBand(level);
  for (const b of (BAND_FALLBACK[band] || ['Medium', 'Easy', 'Hard'])) {
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
export function parseMarkers(text, priorRevealed) {
  const revealed = new Set(priorRevealed || []);
  let verdict = null;

  const vMatch = text.match(/<verdict>\s*(pass|retry)\s*<\/verdict>/i);
  if (vMatch) verdict = vMatch[1].toLowerCase();

  const revRe = /<reveal>\s*([a-zA-Z0-9_-]+)\s*<\/reveal>/gi;
  let m;
  while ((m = revRe.exec(text)) !== null) revealed.add(m[1]);

  // Remove every marker from the visible reply.
  const reply = text
    .replace(/<verdict>[\s\S]*?<\/verdict>/gi, '')
    .replace(/<reveal>[\s\S]*?<\/reveal>/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { reply, verdict, revealedExhibits: Array.from(revealed) };
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
function hintsBlock(step, attemptCount) {
  const h = (step && step.hints) || {};
  const n = Number(attemptCount) || 0;
  if (n <= 0) {
    return '\n\nHINT POLICY: This is the candidate\'s first attempt at this step (L0). Do NOT give any hint, nudge, or leading language. Ask the question and let them work.';
  }
  const lines = [];
  if (n >= 2 && h.L1) lines.push(`Level-1 nudge (offer only as a gentle steer, never the answer): ${h.L1}`);
  if (n >= 3 && h.L2) lines.push(`Level-2 nudge (a stronger steer, still not the full answer): ${h.L2}`);
  if (!lines.length) {
    return `\n\nHINT POLICY: The candidate has struggled (${n} attempt(s)). You may give a light directional nudge toward the right MOVE, but never state the answer.`;
  }
  return `\n\nHINT POLICY: The candidate has made ${n} attempt(s) on this step. You may now weave in the following nudge(s) — as a steer toward the right move, never the answer itself:\n- ${lines.join('\n- ')}`;
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

/* ───────────────────────── system prompt assembly ───────────────────────────
   Rebuilt for the CURRENT step on every call. interviewer_md is the answer key,
   used only to grade — never read aloud. */
export function buildSystemPrompt({ caseObj, stepIndex, attemptCount, firm, revealedSet, isOpening, focusKey, lang }) {
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

CURRENT STEP ${idx + 1} of ${steps.length} — "${step.label || ''}"
QUESTION TO ASK THE CANDIDATE:
${step.candidate_md || step.label || ''}

ANSWER KEY (hidden — grade against this):
${step.interviewer_md || '(No explicit key parsed for this step. Grade using the case prompt, the exhibits, and standard MBB rigor for a step of this type. Any answer text embedded in the question above is interviewer-side — do not read it out.)'}`;

  const ex = exhibitsBlock(caseObj, revealedSet);
  const hints = hintsBlock(step, attemptCount);

  let flow;
  if (isOpening) {
    flow =
`\n\n════ WHAT TO DO NOW (OPENING) ════
This is the start of the case. Do the following, briefly and in character:
1. Present the case prompt / scenario to the candidate in your own words.
2. Present any EXHIBITS marked "available to share" above only if this first step calls for them; otherwise hold them.
3. Ask the CURRENT STEP question above.
Do NOT evaluate anything yet and do NOT emit a <verdict> marker on this opening turn. Keep it tight and professional — no filler.`;
  } else {
    const advance = isLast
      ? `Since this is the LAST step, do NOT ask a new question — give a brief, professional closing line and stop.`
      : `Then transition and ask the NEXT step's question:\n"${(nextStep && (nextStep.candidate_md || nextStep.label)) || ''}"`;
    flow =
`\n\n════ WHAT TO DO NOW (EVALUATE) ════
Grade the candidate's latest message against the ANSWER KEY for the current step.

- If the answer meets the bar for this step (captures the key insight / correct math / required structure): end your reply with the hidden marker <verdict>pass</verdict>. ${advance}
- If it does not yet meet the bar: give a short, demanding, specific nudge toward the right MOVE (obeying the HINT POLICY below — never reveal the answer), then end your reply with the hidden marker <verdict>retry</verdict>. Do NOT advance.

Rules for every reply:
- Exactly ONE hidden <verdict> marker, on its own, at the very end.
- Reveal a GATED exhibit only when the candidate asks about its triggers, prefixing with <reveal>id</reveal>.
- Zero filler ("great question", "let me think"). Be concise, concrete, numeric. 2–5 sentences plus at most one question.
- Never present a number that is not in the material above. Never change a number you already gave.`;
  }

  const languageRu =
`\n\n════ OUTPUT ════
Веди кейс ПОЛНОСТЬЮ НА РУССКОМ ЯЗЫКЕ — каждый вопрос, каждая реплика, каждая подсказка. Профессиональный консалтинговый русский: стандартные термины (NPV, EBITDA, churn, capex, MECE) допустимы как есть, но никаких английских ФРАЗ и предложений. Названия кейсов и компаний оставляй как написаны. Все числа, единицы и проценты — в точности из материала. Скрытые маркеры (<verdict>…</verdict>, <reveal>…</reveal>) оставляй ровно как есть; кандидату их не показывай и не объясняй.`;
  const language = (lang === 'ru') ? languageRu :
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
  const stable = header + ex.stableText + language;
  const volatile = answerKey + ex.volatileText + hints + (isOpening ? '' : focusBlock(focusKey)) + flow;
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
  try {
    const resp = await fetchWithTimeout(sbUrl + '/rest/v1/rpc/check_and_increment_rate_limit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: sbKey, Authorization: 'Bearer ' + token },
      body: JSON.stringify({ p_user_id: userId, p_window_seconds: RATE_WINDOW_MS / 1000, p_limit: RATE_LIMIT })
    }, AUTH_TIMEOUT_MS);
    if (!resp.ok) { console.error('Rate-limit RPC returned', resp.status); return false; }
    const withinLimit = await resp.json();
    return withinLimit === false;
  } catch (e) {
    console.error('Rate-limit RPC failed:', e);
    return false; // fail open, same as claude.js
  }
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

    // 3) Verify the token with Supabase.
    let userResp;
    try {
      userResp = await fetchWithTimeout(sbUrl + '/auth/v1/user',
        { headers: { apikey: sbKey, Authorization: 'Bearer ' + token } }, AUTH_TIMEOUT_MS);
    } catch (e) {
      return res.status(504).json({ error: { message: 'Authentication timed out. Please try again.' } });
    }
    if (!userResp.ok) return res.status(401).json({ error: { message: 'Invalid or expired session.' } });
    const user = await userResp.json();
    const userId = user && user.id;
    if (!userId) return res.status(401).json({ error: { message: 'Invalid session.' } });

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
    const messages = clientMsgs
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-80)
      .map(m => ({ role: m.role, content: m.content }));

    const isOpening = !hasAssistantTurn(messages);
    // Anthropic requires the conversation to start with a user turn.
    const convo = messages.length ? messages : [{ role: 'user', content: 'Please begin the case.' }];
    if (convo[0].role !== 'user') convo.unshift({ role: 'user', content: 'Please begin the case.' });

    // Cache the conversation prefix: mark the last message as a cache breakpoint
    // so every prior turn is a cache hit on the next request.
    const lastMsg = convo[convo.length - 1];
    convo[convo.length - 1] = {
      role: lastMsg.role,
      content: [{ type: 'text', text: lastMsg.content, cache_control: { type: 'ephemeral' } }]
    };

    // Weakness focus: whitelist key only — free text never enters the prompt.
    const focusKey = ['structure','quant','logic','comm','ownership'].includes(body.focusDimension) ? body.focusDimension : null;
    const lang = body.lang === 'ru' ? 'ru' : 'en';   // whitelist
    const built = buildSystemPrompt({ caseObj, stepIndex, attemptCount, firm: body.firm, revealedSet, isOpening, focusKey, lang });

    // 7) Forward to Anthropic. Two system blocks: the STABLE case body is cached
    // (identical every turn → cache hit); the VOLATILE step block is not.
    let response;
    try {
      response = await fetchAnthropicWithRetry('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31'
        },
        body: JSON.stringify({
          model: CASE_MODEL,
          max_tokens: MAX_TOKENS,
          system: [
            { type: 'text', text: built.stable, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: built.volatile }
          ],
          messages: convo
        })
      }, UPSTREAM_TIMEOUT_MS, 4);
    } catch (e) {
      return res.status(504).json({ error: { message: 'The interviewer is taking too long. Please try again.' } });
    }

    const data = await response.json();
    if (response.status < 200 || response.status >= 300) {
      // Pass through status; never leak upstream internals.
      console.error('case-session upstream non-2xx', response.status, JSON.stringify(data).slice(0, 300));
      return res.status(response.status).json({ error: { message: 'The interviewer is busy right now. Please try again.' } });
    }

    // Concatenate every text block (the model may return thinking/other blocks first).
    const text = Array.isArray(data && data.content)
      ? data.content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim()
      : '';
    if (!text) {
      const shape = data && typeof data === 'object'
        ? JSON.stringify({ type: data.type, stop_reason: data.stop_reason, blocks: Array.isArray(data.content) ? data.content.map(b => b && b.type) : typeof data.content, err: data.error && data.error.type }).slice(0, 300)
        : String(data).slice(0, 200);
      console.error('case-session empty text from upstream:', shape);
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

    return res.status(200).json({
      reply: parsed.reply || 'No response was returned. Please try again.',
      verdict: verdict,
      revealedExhibits: parsed.revealedExhibits,
      exhibits: exhibitCards
    });
  } catch (err) {
    console.error('CasEdge case-session error:', err);
    return res.status(500).json({ error: { message: 'Something went wrong. Please try again.' } });
  }
}
