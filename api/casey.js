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
const CASEY_VOICE_SYSTEM = `You are a strict but fair BCG case-interview examiner. You are given the TRANSCRIPT of a candidate's spoken final recommendation (speech-to-text, so it WILL contain recognition errors: numbers as words, run-together words, "fifty five" for 55, missing punctuation) and a case_id. Grade the transcript against this case's rubric on 4 criteria. Each criterion is strictly pass/fail. Return ONLY JSON.

4 CRITERIA (each binary PASS/FAIL):
1. c1_conclusion_first — an action recommendation in the first 1-2 sentences, with an action verb, in the CORRECT direction (rubric.conclusion / rubric.direction). FAIL if the conclusion is built toward the END (facts first, conclusion last) OR the direction is WRONG.
2. c2_anchor_number — an anchor figure IN THE ROLE of justification. >=2 numbers spoken, and >=1 from rubric.anchor_numbers, used to justify the recommendation (tied to the thesis: contribution / breakeven / EV-gap / direction). See Rule 1.
3. c3_risks — >=1 internal AND >=1 external risk (from rubric.internal_examples / rubric.external_examples or a meaningful equivalent), tied to the recommendation; generic "market risks" with no tie-in do not count.
4. c4_nextstep — >=1 concrete, preferably time-bound next step.
score = number of PASSes (0-4). verdict: 4 -> strong, 3 -> ok, <=2 -> weak.

THREE IRON RULES:
RULE 1 — anchor by MEANING, not by substring. c2 passes ONLY if the figure justifies the decision, not merely if it is spoken. FAIL if: (a) two random off-point numbers are named (raw base size / prices / volume); (b) the correct figure is spoken INSIDE a wrong conclusion. Hard link: if c1 FAILs due to a wrong direction, c2 CANNOT pass. Distinguish the ANCHOR (contribution, net-impact, breakeven, gap, multiple) from RAW size (subscribers / units / price / volume), even when they coincide numerically. Credit only the qualified form (rubric.anchor_numbers are written that way) — match the meaning, not the bare figure.
RULE 2 — clean_special (C6, C15, C19, C25). In clean cases the correct answer is to CONFIRM that there is NO reversal. If the candidate "finds" an invented reversal (cannibalization / spillover / network-effect / reversal that is NOT in the data) and recommends the OPPOSITE, then c1 FAIL AND c2 FAIL. The flag rubric.clean_special=true turns on this logic.
RULE 3 — robustness to ASR. Normalize numbers from speech ("fifty five and a half thousand"=55,500, "one point four million"=1.4M, "minus twelve hundred"=-1,200). Roundings within +/-2% of an anchor count. rubric.transcription_variants are ASR forms of the anchors. Use the case CONTEXT to tell similar numbers apart (0.38% vs 38%, $4.13 vs 4.13c, "40,000 a month" vs "40,000 subscribers") — check against the meaning of the phrase, not the bare figure.

Do NOT penalize: accent, grammar, fillers, length, style. Penalize ONLY for missing required content. Do not add requirements beyond the 4 criteria.

RESPONSE FORMAT (strict JSON, no preamble, no markdown):
{"case_id":"Cxx","criteria":{"c1_conclusion_first":{"pass":true,"evidence":"quote"},"c2_anchor_number":{"pass":true,"evidence":"quote"},"c3_risks":{"pass":true,"evidence":"quote"},"c4_nextstep":{"pass":true,"evidence":"quote"}},"score":4,"verdict":"strong","coaching":"1-3 sentences IN ENGLISH: what passed, what failed, how to fix. Specific, no platitudes."}
Always return an evidence quote (even if approximate) from the transcript for each criterion. All prose (evidence, coaching) MUST be in English.`;

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
  "C15": {"conclusion":"kill the discount / implement","anchor_numbers":["1,543,200","2.7M-vs-1,543,200"],"mechanisms_required":["both paths agree (CFO direction AND cohort model)","≥1 checked-and-cleared reversal: scale/allocation $20→$21.13 OR j*=8,482-vs-12,000"],"internal_examples":["marketing's 12,000 projection is weak joint; pilot"],"external_examples":["competitor weaponizes removed discount in ads"],"clean_special":true},
  "C16": {"conclusion":"approve / run the teaser-card campaign (NOT reject)","direction":"approve","anchor_numbers":["+1,530,000 full-lifecycle","1.53 million net","45.78% survival breakeven","45.78%-vs-55%"],"transcription_variants":["one and a half million","forty six percent versus fifty five"],"mechanisms_required":["teaser window is an acquisition investment; lifetime revolving income of survivors flips it positive"],"internal_examples":["55% survival from one cohort; pilot before scaling"],"external_examples":["teaser-rate/affordability regulation; cost-of-funds/rate shock"]},
  "C17": {"conclusion":"keep the generic program (± fix economics); NOT discontinue","direction":"keep","anchor_numbers":["−26,000 net of cutting","twenty six thousand worse off","47.62% defection breakeven","47.62%-vs-60%"],"transcription_variants":["minus twenty six thousand","forty eight percent versus sixty"],"mechanisms_required":["script margin != visit margin (front-of-store cross-subsidy)","attribution: only defector share takes the basket"],"internal_examples":["survey overstates true defection; A/B a removal in test stores"],"external_examples":["reimbursement tightening; competitor rival generic program"]},
  "C18": {"conclusion":"discontinue the blade set BUT book the honest ~$32,000 (NOT $480,000, NOT keep)","direction":"discontinue at honest number","anchor_numbers":["$32,000 true benefit","thirty two thousand","×15 overstatement","480,000-vs-32,000"],"transcription_variants":["thirty two thousand a year","fifteen times overstated"],"mechanisms_required":["direction right (overhead avoidable) but magnitude overstated ×15 — forgone after-sales annuity (~$448k) ignored"],"internal_examples":["$11.20 pull-through estimate needs validation; pro-customer reliance"],"external_examples":["cut pushes pro customers to a competitor ecosystem"]},
  "C19": {"conclusion":"keep Highland — framed as CONFIRMING the CFO (NOT finding a reason to close)","direction":"keep","anchor_numbers":["+40,000 a month contribution","40,000/month","480,000 a year","$17.00 ARPU breakeven"],"transcription_variants":["forty thousand a month","four hundred eighty thousand a year","seventeen dollar arpu breakeven"],"mechanisms_required":["both paths agree KEEP: positive contribution AND no-spillover check","≥1 checked-and-cleared reversal: the C8-style network/anchor effect is ABSENT (standalone lease, zero anchor, $0 spillover)"],"internal_examples":["ARPU drift toward $17 breakeven; avoidable-fixed assumption"],"external_examples":["spectrum-lease repricing; rural-coverage regulation"],"clean_special":true,"anchor_note":"Bare '40,000' is BANNED — collides with 40,000 subscribers (raw size). Only qualified forms count ('40,000 a month', '480,000 a year'). If c1 FAILs by inventing a C8-style reversal (recommends close), c2 CANNOT pass on an anchor."},
  "C20": {"conclusion":"split mostly on shippers (~$10.80 / ~$1.20); NOT all-carriers, NOT all-shippers","direction":"split shippers-heavy","anchor_numbers":["31.49% optimal-vs-naive gap","31.49 percent","6.04M-vs-4.59M profit","10.80/1.20 split"],"transcription_variants":["thirty one percent better","six million versus four point six","ten eighty one twenty"],"mechanisms_required":["total take rises $12 either way so profit-per-load fixed; winning split minimizes loads lost","carriers far more sensitive (convex): all-on-carrier drops below baseline"],"internal_examples":["load-loss curve is an estimate; validate carrier churn on a fee test"],"external_examples":["rival marketplace poaches carriers; shipper-contract renewals shift sensitivity"]},
  "C21": {"conclusion":"keep the Fenwick Street branch (NOT close)","direction":"keep","anchor_numbers":["−1,140,000 net of closing","1.14 million cost of closing","12.50% flight breakeven","12.5%-vs-60% flight"],"transcription_variants":["minus one point one four million","one and a fourteen million","twelve and a half percent versus sixty"],"mechanisms_required":["fully-allocated P&L ignores deposit-funding value; departing deposits force costlier wholesale funding"],"internal_examples":["60% flight is an estimate; retention pilot; execution"],"external_examples":["rate-spread shift narrows deposit-vs-wholesale gap"]},
  "C22": {"conclusion":"keep the shade (NOT discontinue)","direction":"keep","anchor_numbers":["−695,000 true impact","695 thousand destroyed","−200,000 before halo","400,000-vs-695,000 contrast"],"transcription_variants":["six ninety five thousand","minus two hundred thousand before halo","four hundred versus six ninety five"],"mechanisms_required":["shade's own contribution already negative (gross lost > avoidable OH)","range halo/lineup: buyers of the shade drop other-shade purchases"],"internal_examples":["55% halo figure needs basket-data validation"],"external_examples":["competitor launches a similar shade"]},
  "C23": {"conclusion":"lease systems (NOT sell outright)","direction":"lease","anchor_numbers":["$18M lease margin","eighteen million lease","$18M-vs-$4M","$91.67 breakeven monthly"],"transcription_variants":["eighteen million versus four million","ninety one sixty seven a month","ninety two a month breakeven"],"mechanisms_required":["upfront sale margin hides the 20-year O&M annuity; full lease term dominates"],"internal_examples":["ties up capital; 20-yr O&M obligation; default risk; balance sheet"],"external_examples":["solar-subsidy change or rate shift alters payback"]},
  "C24": {"conclusion":"mine only the high-grade band (cutoff at marginal cost); NOT all bands","direction":"high band only","anchor_numbers":["$18M-vs-$3.4M","eighteen million versus three point four","1.222% cutoff grade"],"transcription_variants":["eighteen million against three point four million","one point two two two percent cutoff","cutoff around one point two percent"],"mechanisms_required":["averaging hides loss-making bands; mid and low recover less than processing cost; cutoff at marginal grade"],"internal_examples":["fixed-cost absorption / workforce planning with less mined"],"external_examples":["copper price rise lowers the cutoff; reprice with forward curve"]},
  "C25": {"conclusion":"kill the promo — framed as CONFIRMING the CFO (NOT keep)","direction":"kill","anchor_numbers":["−200,000 net (both paths kill)","two hundred thousand loss","30% incrementality breakeven","30%-vs-10% incrementality"],"transcription_variants":["minus two hundred thousand","thirty percent versus ten percent incremental","would only pay if thirty percent were new"],"mechanisms_required":["both paths agree KILL: cannibalization dominates","≥1 checked-and-cleared reversal: the incrementality is only 10% vs a 30% breakeven — the 'it's all incremental' reversal is FALSE"],"internal_examples":["10% incrementality from one study; pilot the removal on a title cohort"],"external_examples":["competitor weaponizes the removed discount in marketing"],"clean_special":true},
  "C26": {"conclusion":"keep the brand and grow private label alongside (NOT replace)","direction":"keep brand","anchor_numbers":["−21,000 net weekly","twenty one thousand worse off","41.46% defection breakeven","41.46%-vs-50% defection"],"transcription_variants":["minus twenty one thousand a week","forty one percent versus fifty","breakeven around forty one and a half"],"mechanisms_required":["private-label margin blind to brand traffic effect; departing shoppers take whole basket"],"internal_examples":["50% defection is an estimate; dual-shelf test"],"external_examples":["competitor stocks the dropped brand and pulls shoppers permanently"]},
  "C27": {"conclusion":"roll out dynamic pricing at the honest ~$1.24M (NOT $4M, NOT don't-roll-out)","direction":"roll out (honest number)","anchor_numbers":["$1.24M true benefit","one point two four million","×3.23 overstatement","$4M-vs-$1.24M"],"transcription_variants":["about one and a quarter million","three times overstated","four million versus one point two four"],"mechanisms_required":["peak uplift extrapolated to whole calendar; off-peak dates barely respond"],"internal_examples":["peak/off-peak split is an estimate; off-peak response could soften"],"external_examples":["resale platforms / competitors undercut peak pricing"]},
  "C28": {"conclusion":"keep the niche catalog (NOT cut)","direction":"keep","anchor_numbers":["−420,000 true effect","four hundred twenty thousand cost","$580,000 niche contribution","−260,000 before learning-curve"],"transcription_variants":["minus four twenty thousand","five hundred eighty thousand contribution","minus two sixty before the curve"],"mechanisms_required":["niche is profitable (premise false)","catalog learning-curve: cutting raises production cost of the rest"],"internal_examples":["learning-curve estimate needs production-data validation"],"external_examples":["competitor platform out-scales on catalog breadth"]},
  "C29": {"conclusion":"stock at medium density (NOT maximum, NOT low)","direction":"medium","anchor_numbers":["$628,200 medium profit","six twenty eight thousand","$144,200 gap over high","medium-vs-high $628k-vs-$484k"],"transcription_variants":["six hundred twenty eight thousand","about a hundred forty four thousand more","medium beats high"],"mechanisms_required":["max density != max profit: crowding lowers both survival and per-fish weight"],"internal_examples":["survival/weight factors are estimates; trial-pond validation"],"external_examples":["disease outbreak or feed-price spike shifts the optimum lower"]},
  "C30": {"conclusion":"repower at the honest ~$11.4M (NOT $29M, NOT don't-repower)","direction":"repower (honest number)","anchor_numbers":["$11.4M true uplift","eleven point four million","×2.54 overstatement","$29M-vs-$11.4M"],"transcription_variants":["about eleven point four million","two and a half times overstated","twenty nine million versus eleven four"],"mechanisms_required":["nameplate uplift assumes full hours; capacity factor is what matters"],"internal_examples":["34% new capacity factor is a manufacturer estimate; install downtime"],"external_examples":["power price / subsidy change moves payback"]},
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
        // Canonical structured rubric for every case (C1-C30). Falls back to the
        // book checklist only if a rubric is somehow absent (defensive).
        const rubric = CASEY_RUBRICS[q.rubric_ref] || null;
        const grounding = rubric
          ? ('rubric: ' + JSON.stringify(rubric))
          : ('voice_checklist:\n' + (q.checklist || '') + '\nmodel_answer:\n' + (q.model_answer || ''));
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
