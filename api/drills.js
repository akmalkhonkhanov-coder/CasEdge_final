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

const DRILLS_CM = require('./_drills_cm.json');
const DRILLS_MS = require('./_drills_ms.json');
const DRILLS_ST = require('./_drills_st.json');
// Curated libraries share one endpoint. Client passes set:'ms' (Market Sizing),
// set:'st' (Structuring), else Case Math. IDs are disjoint (CM-*/MS-*/ST-*).
function libData(body) {
  const s = body && body.set;
  if (s === 'ms') return DRILLS_MS;
  if (s === 'st') return DRILLS_ST;
  return DRILLS_CM;
}

const FALLBACK_ORIGIN = 'https://cas-edge-final.vercel.app';
const GRADER_MODEL = 'claude-sonnet-5';
const MAX_BODY_BYTES = 200 * 1024;
const RATE_LIMIT = 40;
const RATE_WINDOW_MS = 60 * 1000;
const AUTH_TIMEOUT_MS = 8 * 1000;

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
3. ME: if the candidate merges two branches the ME matrix marks incompatible, flag it — a hard merge of an incompatible pair is a fail; a soft-overlap pair is a warning, not a fail.
4. ORDER: a defensible start is any branch justified by a real criterion (size of effect, speed to check, cost of data). Starting on a decoy is an ORDER defect. Not stating any criterion is a coaching note, not a fail.
5. Do NOT reward tree LENGTH or generic templates (e.g. a blank "profitability = revenue − cost" with no tailoring). Reward branches tailored to THIS company and question.

PASS = all COVER branches present (by meaning) AND no decoy developed first AND no hard ME violation.

RESPONSE FORMAT (strict JSON): {"pass":true,"coaching":"1-2 sentences IN ENGLISH: name which required branch (if any) was missed, or the decoy/ME slip, and the single most valuable fix. Be specific to this case."}`;

/* ───────────────────────── library ───────────────────────────────────────── */
let _byId = null;
function drillById(id) {
  // one combined map across all libraries — ids are disjoint (CM-*/MS-*/ST-*)
  if (!_byId) { _byId = new Map(); for (const src of [DRILLS_CM, DRILLS_MS, DRILLS_ST]) for (const d of (src.drills || [])) _byId.set(d.id, d); }
  return _byId.get(id);
}

// Client-safe view: prompt / exhibit / step prompts / meta — NO checklist,
// reference, provoked, key registers, or step answers.
// ST drills: the `key` registers (COVER/ME/DRIVE/ORDER/DECOY), anchor_metric and
// reference are server-only. For E-after drills the exhibit itself is WITHHELD
// until the candidate has submitted a tree (revealed=true) — the whole point is
// that the data breaks the framework they already built.
function sanitizeDrill(d, index, total, revealed) {
  const isAfter = d.exhibit_mode === 'E-after';
  const exhibit = (isAfter && !revealed) ? null : (d.exhibit || null);
  return {
    id: d.id, title: d.title, difficulty: d.difficulty, type: d.type,
    focus: d.focus, time: d.time,
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
async function fetchAnthropicWithRetry(url, options, timeoutMs, maxRetries) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(Math.min(700 * Math.pow(2, attempt - 1), 4000));
    try {
      const resp = await fetchWithTimeout(url, options, timeoutMs);
      if (RETRIABLE_STATUS.has(resp.status) && attempt < maxRetries) continue;
      return resp;
    } catch (e) { lastErr = e; if (attempt >= maxRetries) throw e; }
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
    if (!resp.ok) { console.error('Drills rate-limit RPC returned', resp.status); return false; }
    return (await resp.json()) === false;
  } catch (e) { console.error('Drills rate-limit RPC failed:', e); return false; }
}

// One bounded model call + a single truncation retry inside a hard deadline.
async function graderJSON(system, userText, maxTokens) {
  const T0 = Date.now();
  const BUDGET_MS = 52 * 1000;
  const call = (mt, timeoutMs) => fetchAnthropicWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31'
    },
    body: JSON.stringify({ model: GRADER_MODEL, max_tokens: mt, system: [{ type: 'text', text: system }], messages: [{ role: 'user', content: userText }] })
  }, timeoutMs, 0);
  const textOf = dd => (dd && Array.isArray(dd.content)) ? dd.content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
  const parse = t => { try { const m = String(t || '').match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; } catch (e) { return null; } };
  let resp = await call(maxTokens, 45 * 1000);
  let data = await resp.json();
  let parsed = parse(textOf(data));
  // Retry once inside the deadline on truncation OR unparseable output.
  const needsRetry = !parsed || (data && data.stop_reason === 'max_tokens');
  const timeLeft = BUDGET_MS - (Date.now() - T0);
  if (needsRetry && timeLeft > 12 * 1000) {
    try { const r2 = await call(Math.min(maxTokens * 2, 2000), timeLeft - 2000); if (r2.status === 200) { const d2 = await r2.json(); const p2 = parse(textOf(d2)); if (p2) parsed = p2; } } catch (e) { /* keep */ }
  }
  return parsed;
}

async function gradeDrill(d, answer) {
  // ST (Structuring): grade the candidate's tree against the five registers.
  if (d.type === 'Structuring' && d.key) {
    const k = d.key;
    const exhibitTxt = d.exhibit ? ('EXHIBIT (visible to candidate for this grade):\n' + JSON.stringify({ header: d.exhibit.header, rows: d.exhibit.rows })) : 'EXHIBIT: none / withheld';
    const u = 'ANCHOR QUESTION: ' + d.prompt +
      '\n\n--- GRADING REGISTERS (answer key) ---' +
      '\nCOVER (required branches):\n' + (k.cover || '') +
      '\n\nDECOY (reflexive branches — must not lead):\n' + (k.decoy || '') +
      '\n\nME (incompatible pairs):\n' + (k.me || '') +
      '\n\nORDER (defensible starts):\n' + (k.order || '') +
      '\n\n' + exhibitTxt +
      '\n\n--- CANDIDATE TREE ---\n' + String(answer || '');
    const j = await graderJSON(ST_GRADER_SYSTEM, u, 500);
    return j || { pass: false, coaching: 'Could not grade — please try again.' };
  }
  const exhibitTxt = d.exhibit ? ('EXHIBIT ' + JSON.stringify({ header: d.exhibit.header, rows: d.exhibit.rows })) : 'EXHIBIT: none';
  const u = 'PROMPT: ' + d.prompt +
    '\n' + exhibitTxt +
    '\nSTEPS ASKED: ' + (d.step_prompts || []).join(' | ') +
    '\nPASS CHECKLIST: ' + (d.checklist && d.checklist.en || '') +
    '\nREFERENCE SOLUTION: ' + (d.reference && d.reference.en || '') +
    '\nCANDIDATE ANSWER: ' + String(answer || '');
  const j = await graderJSON(DRILL_GRADER_SYSTEM, u, 500);
  return j || { pass: false, coaching: 'Could not grade — please try again.' };
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

    let userResp;
    try {
      userResp = await fetchWithTimeout(sbUrl + '/auth/v1/user', { headers: { apikey: sbKey, Authorization: 'Bearer ' + token } }, AUTH_TIMEOUT_MS);
    } catch (e) { return res.status(504).json({ error: { message: 'Authentication timed out. Please try again.' } }); }
    if (!userResp.ok) return res.status(401).json({ error: { message: 'Invalid or expired session.' } });
    const user = await userResp.json();
    const userId = user && user.id;
    if (!userId) return res.status(401).json({ error: { message: 'Invalid session.' } });

    const body = req.body || {};

    if (body.action === 'list') {
      return res.status(200).json({ drills: (libData(body).drills || []).map(d => ({ id: d.id, title: d.title, difficulty: d.difficulty, focus: d.focus })) });
    }
    if (body.action === 'next') {
      const nd = nextDrill(body.doneIds, libData(body));
      return res.status(200).json({ drill: nd });     // null when the set is exhausted
    }
    if (body.action === 'grade') {
      if (await rateLimited(userId, sbUrl, sbKey, token)) {
        return res.status(429).json({ error: { message: 'Too many requests. Please slow down.' } });
      }
      const d = drillById(body.drillId);
      if (!d) return res.status(400).json({ error: { message: 'Unknown drill.' } });
      const r = await gradeDrill(d, body.answer);
      // ST E-after: reveal the exhibit only now (after the tree is submitted), so
      // the candidate can see how the data breaks their framework, then refine.
      const revealExhibit = (d.type === 'Structuring' && d.exhibit_mode === 'E-after' && d.exhibit) ? d.exhibit : null;
      return res.status(200).json({
        pass: !!r.pass,
        coaching: r.coaching || '',
        reference: d.reference || { en: '', ru: '' },
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
