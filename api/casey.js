// CasEdge — Casey Simulator server endpoint. Owns the case library AND all
// grading for the BCG Casey game, so answer keys never reach the browser.
//
// Mirrors api/claude.js / api/case-session.js security: locked CORS, Supabase
// bearer verification, shared per-user rate limit, body limits, upstream
// timeout + no error leakage. The library (_casey_cases.json) and every answer
// key (option.correct, answer, validation, answer_explain, model_answer,
// trigger_phrases, rubrics) live ONLY here. The client receives sanitized cases
// (prompts, option TEXT, exhibits — no keys) and, per graded step, a verdict.
//
// Actions:
//   list   → [{id,title,meta_tag}]                    (picker; no spoilers)
//   case   → {id,title,meta_tag,scenario,exhibits,steps:[flattened+sanitized]}
//   grade  → {gid, payload} graded server-side → verdict (+ post-answer explain)

const CASES_DATA = require('./_casey_cases.json');

const FALLBACK_ORIGIN = 'https://cas-edge-final.vercel.app';
const GRADER_MODEL = 'claude-sonnet-5';
const MAX_BODY_BYTES = 200 * 1024;
const RATE_LIMIT = 40;                 // slightly higher: a case has many graded steps
const RATE_WINDOW_MS = 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 50 * 1000;
const AUTH_TIMEOUT_MS = 8 * 1000;

/* ───────────────────────── voice grader (server-side) ─────────────────────── */
const CASEY_VOICE_SYSTEM = [
"You are a strict but fair BCG case-interview examiner. You are given the TRANSCRIPT of a candidate's spoken final recommendation (speech-to-text, so it WILL contain recognition errors: numbers as words, typos, run-together words, missing punctuation). Grade the transcript against a 4-criterion checklist. Each criterion is strictly pass/fail. Return ONLY JSON, no preamble, no markdown.",
"INTERPRETATION RULES:",
"1. Meaning over exact words — the candidate spoke aloud; grade the substance.",
"2. Numbers in any form ('fifty five and a half thousand' = 55,500; 'minus one hundred twenty thousand eight hundred' = -120,800). Candidate rounding within +/-2% of an anchor counts.",
"3. Order matters ONLY for criterion 1 (conclusion-first). For 2-4, credit it anywhere in the transcript.",
"4. Criterion 1 (conclusion in the first 1-2 sentences): look for an action recommendation in the first ~2 sentences. If the candidate builds from facts to a conclusion at the end, c1 FAILS even if the conclusion is correct.",
"5. Criterion 2 (anchor): >=2 numbers must be spoken, and >=1 of them must come from the rubric's anchor_numbers. Two random off-point numbers → c2 FAIL.",
"6. Criterion 3 (mechanisms): for multi-insight, both named; for single-insight, the one required point (see mechanisms_required).",
"7. Criterion 4: >=1 internal + >=1 external risk tied to the thesis, AND >=1 concrete time-bound next step.",
"8. Clean cases (clean_special=true): the anchor is confirming BOTH paths. If the candidate 'found a flip' that isn't there, c1 AND c2 FAIL.",
"9. Do NOT penalize: accent, grammar, fillers, length, style. Only missing required content.",
"10. Do NOT add requirements beyond the checklist.",
"RESPONSE FORMAT (strict JSON):",
'{"case_id":"Cxx","criteria":{"c1_conclusion_first":{"pass":true,"evidence":"quote"},"c2_anchor_number":{"pass":true,"evidence":"quote"},"c3_mechanisms":{"pass":false,"evidence":"quote"},"c4_risks_nextstep":{"pass":true,"evidence":"quote"}},"score":3,"verdict":"partial","coaching":"1-3 sentences IN ENGLISH: what passed, what failed, how to fix."}',
"score = number of passes (0-4). verdict: 4->strong, 3->partial, <=2->weak. Always return an evidence quote from the transcript for each criterion. All prose (evidence, coaching) MUST be in English."
].join("\n");

const CASEY_RUBRICS = {
  "C1":  {"conclusion":"keep Valtona + add Herdal top-up (hybrid); NOT full move","anchor_numbers":["55,500","52,000-vs-55,000"],"mechanisms_required":["cost advantage kept + insurance against shortfall"],"internal_examples":["two-site quality/consistency"],"external_examples":["Valtona deviation/contract, excise"]},
  "C2":  {"conclusion":"run promo WITH the 500-unit cap (not uncapped, not reject)","anchor_numbers":["27,500","9,500-vs-87,500","33.65%"],"mechanisms_required":["expected refund cost overstated the gain; cap limits exposure"],"internal_examples":["cap communication/backlash"],"external_examples":["consumer-protection regulation; probability drift past breakeven"]},
  "C3":  {"conclusion":"keep the kit (± reprice); NOT discontinue","anchor_numbers":["−8,400","33.33%-vs-45%"],"mechanisms_required":["basket margin","attribution/defection share"],"internal_examples":["survey overstates true defection; test-store measurement"],"external_examples":["competitor rival kit; food-cost inflation"]},
  "C4":  {"conclusion":"ADD the 4th flight on incremental/marginal logic","anchor_numbers":["505","184,325","43.86%"],"mechanisms_required":["marginal vs fully-allocated cost","cannibalization/incrementality"],"internal_examples":["crew/maintenance/ops strain"],"external_examples":["competitor frequency match; fuel; slots"]},
  "C5":  {"conclusion":"decline at $38 / keep in-house","anchor_numbers":["−120,800","34.79","34-35"],"mechanisms_required":["avoidable vs unavoidable fixed","TAT leakage"],"internal_examples":["molecular staff retention/capability"],"external_examples":["reference-lab repricing; payer reimbursement"]},
  "C6":  {"conclusion":"implement the rate cut / yes","anchor_numbers":["94,900","350,400-vs-94,900"],"mechanisms_required":["both paths agree (revenue AND contribution)","≥1 checked-and-cleared reversal: parity $110 OR breakeven 72.63%-vs-74%"],"internal_examples":["forecast is the weak joint; re-underwrite 74%"],"external_examples":["competitor matching the cut"],"clean_special":true},
  "C7":  {"conclusion":"do NOT implement flat +20% as proposed (restructure, not reject)","anchor_numbers":["−168,869","−169K","+2M-vs-minus","16.48%"],"mechanisms_required":["annual-lock/mix","churn compounding"],"internal_examples":["churn estimates from one study; A/B first"],"external_examples":["competitor holds price → acquisition"]},
  "C8":  {"conclusion":"keep Rural","anchor_numbers":["−12,200","0.38%-vs-5%","10,000→1,000→−12,200"],"mechanisms_required":["avoidable vs allocated fixed","network/anchor-client risk"],"internal_examples":["needs variable-cost program"],"external_examples":["anchor client renegotiation"]},
  "C9":  {"conclusion":"reject the dormant-for-premium swap","anchor_numbers":["−68,250","38.75-vs-35.00","59.55-vs-55"],"mechanisms_required":["usage-cost margin (dormant > premium)","adverse retention on Casual"],"internal_examples":["premium real usage may exceed 8 visits; pilot"],"external_examples":["regulator views mass termination as unfair"]},
  "C10": {"conclusion":"selective / A-only migration (not everyone, not no one)","anchor_numbers":["−66,600-vs-+18,000","4.13"],"mechanisms_required":["segment winners/losers (only A pays more; B,C get unjustified cut)"],"internal_examples":["two pricing models → fairness pushback; packaging"],"external_examples":["B/C demand cheaper usage model → set rate ≥4.13¢"]},
  "C11": {"conclusion":"do NOT approve $12 across the board (targeted/peak pricing instead, not reject-all)","anchor_numbers":["−20,960","9.84-15-16.67","4.16"],"mechanisms_required":["naive ticket math is CORRECT within its perimeter but incomplete (concession leak)"],"internal_examples":["validate 15% elasticity via 2-theatre pilot"],"external_examples":["streaming release-window shift moves attendance"]},
  "C12": {"conclusion":"rent B1 and B3 only (not all five, not reject)","anchor_numbers":["13,000-vs-7,000","$10×participants"],"mechanisms_required":["capacity shadow-price","per-building selection"],"internal_examples":["relocate displaced programs before signing"],"external_examples":["operator demands all-five package → walk/counter"]},
  "C13": {"conclusion":"approve 24-mo cycle at HONEST size (not reject, not $4.9M)","anchor_numbers":["384,000-vs-4.86M","20,573"],"mechanisms_required":["naive frame counts only the selling side of the cycle"],"internal_examples":["doubled purchasing strains supply/logistics"],"external_examples":["used-car market is the single point of failure; hedge disposals"]},
  "C14": {"conclusion":"decline exclusivity / counter (not accept)","anchor_numbers":["−47,240","87.99%-vs-55%","88%","8.50-vs-7.16"],"mechanisms_required":["channel margin difference","partial migration/churn"],"internal_examples":["own-channel ops must stay <$4.90/order"],"external_examples":["Mealgate ranking retaliation → placement guarantees"]},
  "C15": {"conclusion":"kill the discount / implement","anchor_numbers":["1,543,200","2.7M-vs-1,543,200"],"mechanisms_required":["both paths agree (CFO direction AND cohort model)","≥1 checked-and-cleared reversal: scale/allocation $20→$21.13 OR j*=8,482-vs-12,000"],"internal_examples":["marketing's 12,000 projection is weak joint; pilot"],"external_examples":["competitor weaponizes removed discount in ads"],"clean_special":true}
};

/* ───────────────────────── library ───────────────────────────────────────── */
let _byId = null;
function caseById(id) {
  if (!_byId) { _byId = new Map(); for (const c of (CASES_DATA.cases || [])) _byId.set(c.id, c); }
  return _byId.get(id);
}

// Flatten multipart steps the way the client used to, but assign each flat step
// a stable grading id (gid = its index) so client and server never disagree.
function flatten(c) {
  const flat = [];
  (c.steps || []).forEach(st => {
    if (st.type === 'multipart') {
      (st.parts || []).forEach((p, i) => {
        const q = Object.assign({}, p);
        if (i === 0) { q._wrap = st.prompt; q._reveal = st.reveal_exhibits_on_enter; }
        flat.push(q);
      });
    } else {
      const q = Object.assign({}, st);
      if (st.reveal_exhibits_on_enter) q._reveal = st.reveal_exhibits_on_enter;
      flat.push(q);
    }
  });
  flat.forEach((q, i) => { q.gid = i; });
  return flat;
}

const KEY_FIELDS = ['answer', 'answer_explain', 'validation', 'model_answer', 'trigger_phrases', 'expected', 'fallback', 'rubric_ref', 'checklist'];
// Client-safe copy of a flat step: keep prompt / type / option TEXT / reveal ids
// / gid; strip every answer key (incl. the voice checklist, which spoils the
// correct recommendation).
function sanitizeStep(q) {
  const out = {};
  for (const k of Object.keys(q)) {
    if (KEY_FIELDS.indexOf(k) >= 0) continue;
    if (k === 'options') {
      out.options = (q.options || []).map(o => ({ text: o.text }));   // drop .correct
    } else {
      out[k] = q[k];
    }
  }
  return out;
}

// Exhibits carry both display data (blocks/title) AND spoiler metadata
// (trigger_phrases to reveal them, no_spoiler_note, fallback). Ship only what
// the renderer needs.
function sanitizeExhibit(ex) {
  return { id: ex.id, title: ex.title, reveal: ex.reveal, blocks: ex.blocks || [] };
}

function sanitizeCase(c) {
  return {
    id: c.id, title: c.title, meta_tag: c.meta_tag, scenario: c.scenario,
    exhibits: (c.exhibits || []).map(sanitizeExhibit),
    steps: flatten(c).map(sanitizeStep)
  };
}

/* ───────────────────────── grading ───────────────────────────────────────── */
function num(v) {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[, ]/g, ''));
  return isNaN(n) ? NaN : n;
}
function fmtVal(v) { const n = num(v); return isFinite(n) ? n.toLocaleString('en-US') : String(v); }

function gradeChoice(q, selected) {
  const req = [];
  (q.options || []).forEach((o, i) => { if (o.correct) req.push(i); });
  const sel = Array.isArray(selected) ? selected.map(Number) : [];
  const ok = req.length === sel.length && req.every(i => sel.indexOf(i) >= 0);
  // correctIdx lets the (key-free) client mark right/wrong options after submit.
  return { ok, correctIdx: req, validation: q.validation || '' };
}
function gradeNumber(q, value) {
  const ans = num(q.answer), val = num(value);
  const tol = Math.max(0.01, Math.abs(ans) * 0.005);
  const ok = isFinite(val) && Math.abs(val - ans) <= tol;
  return { ok, answer: fmtVal(ans), answer_explain: q.answer_explain || '' };
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
    if (!resp.ok) { console.error('Casey rate-limit RPC returned', resp.status); return false; }
    return (await resp.json()) === false;
  } catch (e) { console.error('Casey rate-limit RPC failed:', e); return false; }
}

// One bounded model call + a single thinking-truncation retry inside a hard
// deadline (same discipline as claude.js), returning parsed JSON or null.
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
  const textOf = d => (d && Array.isArray(d.content)) ? d.content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
  let resp = await call(maxTokens, 45 * 1000);
  let data = await resp.json();
  let text = textOf(data);
  const timeLeft = BUDGET_MS - (Date.now() - T0);
  if ((!text || (data && data.stop_reason === 'max_tokens')) && timeLeft > 12 * 1000) {
    try { const r2 = await call(Math.min(maxTokens * 2, 4000), timeLeft - 2000); if (r2.status === 200) { const d2 = await r2.json(); if (textOf(d2)) { data = d2; text = textOf(d2); } } } catch (e) { /* keep */ }
  }
  try { const m = text.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; } catch (e) { return null; }
}

async function gradeOpen(q, answer) {
  const sys = 'You are a strict but fair BCG case-interview examiner. Grade the candidate answer on a binary pass/fail. Return ONLY JSON: {"pass":true|false,"feedback":"1 short sentence IN ENGLISH: what earned or missed the pass"}.';
  const u = 'PASS CRITERION: ' + (q.validation || 'a reasonable, on-point answer') +
    '\nMODEL ANSWER: ' + (q.model_answer || '—') +
    '\nCANDIDATE ANSWER: ' + answer;
  const j = await graderJSON(sys, u, 400);
  return j || { pass: true, feedback: 'Answer accepted.' };
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

    // list — no model call, meta only.
    if (body.action === 'list') {
      return res.status(200).json({ cases: (CASES_DATA.cases || []).map(c => ({ id: c.id, title: c.title, meta_tag: c.meta_tag })) });
    }
    // case — sanitized (no answer keys).
    if (body.action === 'case') {
      const c = caseById(body.caseId);
      if (!c) return res.status(400).json({ error: { message: 'Unknown case.' } });
      return res.status(200).json({ case: sanitizeCase(c) });
    }
    // grade — rate-limited, keys never leave.
    if (body.action === 'grade') {
      if (await rateLimited(userId, sbUrl, sbKey, token)) {
        return res.status(429).json({ error: { message: 'Too many requests. Please slow down.' } });
      }
      const c = caseById(body.caseId);
      if (!c) return res.status(400).json({ error: { message: 'Unknown case.' } });
      const flat = flatten(c);
      const gid = Number(body.gid);
      const q = flat[gid];
      if (!q) return res.status(400).json({ error: { message: 'Unknown step.' } });
      const p = body.payload || {};
      const t = q.type;

      if (t === 'select_all' || t === 'select_fewest' || t === 'single_choice') {
        return res.status(200).json(gradeChoice(q, p.selected));
      }
      if (t === 'enter_number') {
        return res.status(200).json(gradeNumber(q, p.value));
      }
      if (t === 'open_text_elicitation') {
        const answer = String(p.answer || '');
        const trg = (q.trigger_phrases || []).some(ph => answer.toLowerCase().indexOf(String(ph).toLowerCase()) >= 0);
        let pass = trg;
        if (!trg) { const r = await gradeOpen(q, answer); pass = !!r.pass; }
        return res.status(200).json({ pass, validation: q.validation || 'Right thing to probe.', revealExhibit: q.reveal_exhibit || null });
      }
      if (t === 'voice') {
        // Curated rubric (C1-C15) when present; otherwise ground the grader on
        // the case book's own voice checklist + partner model answer (C16-C30).
        const rubric = CASEY_RUBRICS[q.rubric_ref] || null;
        const grounding = rubric
          ? ('rubric: ' + JSON.stringify(rubric))
          : ('voice_checklist (case-specific pass/fail criteria from the case book — derive the required conclusion, anchor numbers, and mechanisms from it):\n' + (q.checklist || '') + '\nmodel_answer (partner-level reference):\n' + (q.model_answer || ''));
        const u = 'case_id: ' + (q.rubric_ref || c.id) + '\n' + grounding + '\ntranscript: ' + String(p.transcript || '');
        const j = await graderJSON(CASEY_VOICE_SYSTEM, u, 1200) || { criteria: {}, score: 0, verdict: 'weak', coaching: 'Could not grade — please try again.' };
        j.model_answer = q.model_answer || '';
        return res.status(200).json(j);
      }
      // open_text / brainstorm
      return res.status(200).json(await gradeOpen(q, String(p.answer || '')));
    }

    return res.status(400).json({ error: { message: 'Unknown action.' } });
  } catch (err) {
    console.error('CasEdge Casey error:', err);
    return res.status(500).json({ error: { message: 'Something went wrong. Please try again.' } });
  }
}
