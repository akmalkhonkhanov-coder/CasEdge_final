// CasEdge — Redrock Study (McKinsey Solve-style) server endpoint.
// Owns the game library AND all grading, so answer keys never reach the browser.
// Mirrors api/case-session.js / api/casey.js security: locked CORS, Supabase
// bearer verification, shared per-user rate limit, body limits, upstream timeout,
// no error leakage. The library (redrock_games.json) and every key (answer,
// naive, naive_reason, justify_rubric, report-blank answers, case answers,
// distractors) live ONLY here. The client receives a sanitized render slice.
//
// Grading is DETERMINISTIC (numeric round+tolerance, dropdown/choice exact) with
// naive-detection (the core Redrock pedagogy). The ONLY LLM call is grading the
// graph-selection justification against justify_rubric.
//
// Actions:
//   list  → [{id,title,world,family,difficulty}]                 (picker; no keys)
//   pick  → adaptive unseen game by family/difficulty band       (meta only)
//   game  → sanitized render slice {objective,study_md,exhibits(auto),analysis,report,cases,fields}
//   grade → {gameId, fieldId, value} graded server-side → {status, feedback, correctAnswer?, naiveReason?}

const GAMES_DATA = require('./redrock-games.json');

const FALLBACK_ORIGIN = 'https://cas-edge-final.vercel.app';
const GRADER_MODEL = 'claude-sonnet-5';
const MAX_BODY_BYTES = 200 * 1024;
const RATE_LIMIT = 40;
const RATE_WINDOW_MS = 60 * 1000;
const AUTH_TIMEOUT_MS = 8 * 1000;

/* ───────────────────────── library ───────────────────────────────────────── */
let _byId = null;
function gameById(id) {
  if (!_byId) { _byId = new Map(); for (const g of (GAMES_DATA.games || [])) _byId.set(Number(g.id), g); }
  return _byId.get(Number(id));
}

/* ───────────────────────── gradeable field map ───────────────────────────────
   Flatten every gradeable field of a game into a stable fieldId → key record.
   The client grades field-by-field with these ids; the server resolves the key. */
function fieldMap(game) {
  const m = new Map();
  const add = (id, rec) => m.set(id, rec);
  // Analysis Q1–Q4, each part
  for (const q of (game.analysis || [])) {
    for (const p of (q.parts || [])) {
      add('a:' + p.key, {
        input: p.input || 'numeric', answer: p.answer, naive: p.naive,
        naive_reason: p.naive_reason, options: p.options || null,
        round: (p.round == null ? 2 : p.round), tolerance: (p.tolerance == null ? 0.01 : p.tolerance)
      });
    }
  }
  // Report — written blanks
  const rep = game.report || {};
  for (const b of ((rep.written && rep.written.blanks) || [])) {
    add('w:' + b.key, {
      input: b.input || 'numeric', answer: b.answer, naive: b.naive, naive_reason: b.naive_reason,
      options: b.options || null, round: (b.round == null ? 2 : b.round), tolerance: (b.tolerance == null ? 0.01 : b.tolerance)
    });
  }
  // Report — graph selection: chart type (deterministic) + justification (LLM)
  if (rep.graph_selection) {
    add('g:type', { input: 'choice', answer: rep.graph_selection.answer, options: rep.graph_selection.options || null });
    add('g:justify', { input: 'justify', justify_rubric: rep.graph_selection.justify_rubric || '' });
  }
  // Report — visual report fields
  for (const f of ((rep.visual_report && rep.visual_report.fields) || [])) {
    add('v:' + f.key, { input: f.input || 'numeric', answer: f.answer, naive: f.naive, naive_reason: f.naive_reason,
      options: f.options || null, round: (f.round == null ? 2 : f.round), tolerance: (f.tolerance == null ? 0.01 : f.tolerance) });
  }
  // Cases 1–6
  for (const c of (game.cases || [])) {
    add('c:' + c.c, { input: c.input || 'numeric', answer: c.answer, naive: c.naive, naive_reason: c.naive_reason,
      options: c.options || null, round: (c.round == null ? 2 : c.round), tolerance: (c.tolerance == null ? 0.01 : c.tolerance) });
  }
  return m;
}

/* ───────────────────────── sanitize (render slice) ───────────────────────────
   Everything the client needs to RENDER, with every answer key stripped.
   Gated (on_request) exhibits are withheld until their triggers fire. */
function sanitizeExhibit(ex, revealedSet) {
  const base = { id: ex.id, title: ex.title, kind: ex.kind, reveal: ex.reveal || 'auto' };
  if ((ex.reveal || 'auto') === 'on_request' && !(revealedSet && revealedSet.has(ex.id))) {
    return { id: ex.id, title: ex.title, kind: ex.kind, reveal: 'on_request', hidden: true };
  }
  base.body = ex.body || null;
  return base;
}
function sanitizeGame(game, revealedSet) {
  const rep = game.report || {};
  return {
    id: game.id, title: game.title, world: game.world, family: game.family,
    difficulty: game.difficulty, est_minutes: game.est_minutes,
    objective: game.objective, study_md: game.study_md,
    // distractors are SERVER-ONLY (their whole point is the Research Journal
    // filtering task) — never label them for the client.
    exhibits: (game.exhibits || []).map(ex => sanitizeExhibit(ex, revealedSet)),
    analysis: (game.analysis || []).map(q => ({
      q: q.q, prompt: q.prompt,
      parts: (q.parts || []).map(p => ({ key: p.key, label: p.label, input: p.input || 'numeric', unit: p.unit || null, options: p.options || null }))
    })),
    report: {
      written: rep.written ? {
        template: rep.written.template,
        blanks: (rep.written.blanks || []).map(b => ({ key: b.key, input: b.input || 'numeric', options: b.options || null }))
      } : null,
      graph_selection: rep.graph_selection ? { prompt: rep.graph_selection.prompt, options: rep.graph_selection.options || [] } : null,
      visual_report: rep.visual_report ? { fields: (rep.visual_report.fields || []).map(f => ({ key: f.key, input: f.input || 'numeric', options: f.options || null })) } : null
    },
    cases: (game.cases || []).map(c => ({ c: c.c, kind: c.kind, prompt: c.prompt, input: c.input || 'numeric', options: c.options || null }))
  };
}

/* ───────────────────────── deterministic grading ─────────────────────────── */
function num(v) {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[$,%\s]/g, ''));
  return isNaN(n) ? NaN : n;
}
function round2(x, d) { const f = Math.pow(10, d == null ? 2 : d); return Math.round((x + Number.EPSILON) * f) / f; }

function gradeNumeric(rec, value) {
  const v = round2(num(value), rec.round);
  if (!isFinite(v)) return { status: 'wrong', feedback: 'Enter a number.' };
  const ans = round2(num(rec.answer), rec.round);
  const tol = Math.max(rec.tolerance == null ? 0.01 : rec.tolerance, Math.abs(ans) * 0.0005);
  if (Math.abs(v - ans) <= tol) return { status: 'correct', correctAnswer: rec.answer };
  if (rec.naive != null) {
    const nv = round2(num(rec.naive), rec.round);
    if (isFinite(nv) && Math.abs(v - nv) <= tol) return { status: 'naive', correctAnswer: rec.answer, naiveReason: rec.naive_reason || '' };
  }
  return { status: 'wrong', correctAnswer: rec.answer };
}
function normExact(s) {
  // forgiving compare for dropdown/choice fields that ship as free text:
  // trim, collapse whitespace, drop surrounding punctuation, case-insensitive.
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ').replace(/^[\s"'(.]+|[\s"').:;,]+$/g, '');
}
function gradeExact(rec, value) {
  const v = normExact(value);
  if (v && v === normExact(rec.answer)) return { status: 'correct', correctAnswer: rec.answer };
  if (rec.naive != null && v && v === normExact(rec.naive)) return { status: 'naive', correctAnswer: rec.answer, naiveReason: rec.naive_reason || '' };
  return { status: 'wrong', correctAnswer: rec.answer };
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
    if (!resp.ok) { console.error('Redrock rate-limit RPC returned', resp.status); return false; }
    return (await resp.json()) === false;
  } catch (e) { console.error('Redrock rate-limit RPC failed:', e); return false; }
}

// One bounded model call inside a hard deadline (case-session.js discipline).
async function graderJSON(system, userText, maxTokens) {
  const T0 = Date.now(); const BUDGET_MS = 52 * 1000;
  const call = (mt, timeoutMs) => fetchAnthropicWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31' },
    body: JSON.stringify({ model: GRADER_MODEL, max_tokens: mt, system: [{ type: 'text', text: system }], messages: [{ role: 'user', content: userText }] })
  }, timeoutMs, 0);
  const textOf = d => (d && Array.isArray(d.content)) ? d.content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
  const parse = t => { try { const m = String(t || '').match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; } catch (e) { return null; } };
  let resp = await call(maxTokens, 45 * 1000);
  let data = await resp.json();
  let parsed = parse(textOf(data));
  const timeLeft = BUDGET_MS - (Date.now() - T0);
  if (!parsed && timeLeft > 12 * 1000) {
    try { const r2 = await call(Math.min(maxTokens * 2, 1500), timeLeft - 2000); if (r2.status === 200) { const p2 = parse(textOf(await r2.json())); if (p2) parsed = p2; } } catch (e) { /* keep */ }
  }
  return parsed;
}
async function gradeGraphJustify(rec, value) {
  const sys = 'You are a strict but fair examiner grading a candidate\'s one-line justification for choosing a chart type in a data-analysis game. Return ONLY JSON: {"pass":true|false,"feedback":"1 short sentence IN ENGLISH: what earned or missed the pass"}.';
  const u = 'PASS CRITERION (rubric): ' + (rec.justify_rubric || 'a reasonable reason naming the data shape') + '\nCANDIDATE JUSTIFICATION: ' + String(value || '');
  const j = await graderJSON(sys, u, 300);
  if (!j) return { status: 'ungraded', feedback: 'Could not grade the justification — please try again.' };
  return { status: j.pass ? 'correct' : 'wrong', feedback: j.feedback || '' };
}

/* ───────────────────────── adaptive pick ─────────────────────────────────── */
function pickGame(body) {
  const games = GAMES_DATA.games || [];
  const seen = new Set((Array.isArray(body.seenIds) ? body.seenIds : []).map(Number));
  const fam = body.family ? String(body.family).toUpperCase() : null;
  const diff = body.difficulty || null;
  let pool = games.filter(g => !seen.has(Number(g.id)));
  if (!pool.length) return { exhausted: true };
  let cand = pool;
  if (fam) { const f = cand.filter(g => String(g.family).toUpperCase() === fam); if (f.length) cand = f; }
  if (diff) { const d = cand.filter(g => (g.difficulty || '') === diff); if (d.length) cand = d; }
  const g = cand[Math.floor(Math.random() * cand.length)];
  return { game: { id: g.id, title: g.title, world: g.world, family: g.family, difficulty: g.difficulty, est_minutes: g.est_minutes } };
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
    try { userResp = await fetchWithTimeout(sbUrl + '/auth/v1/user', { headers: { apikey: sbKey, Authorization: 'Bearer ' + token } }, AUTH_TIMEOUT_MS); }
    catch (e) { return res.status(504).json({ error: { message: 'Authentication timed out. Please try again.' } }); }
    if (!userResp.ok) return res.status(401).json({ error: { message: 'Invalid or expired session.' } });
    const user = await userResp.json();
    const userId = user && user.id;
    if (!userId) return res.status(401).json({ error: { message: 'Invalid session.' } });

    const body = req.body || {};

    if (body.action === 'list') {
      return res.status(200).json({ games: (GAMES_DATA.games || []).map(g => ({ id: g.id, title: g.title, world: g.world, family: g.family, difficulty: g.difficulty })) });
    }
    if (body.action === 'pick') {
      return res.status(200).json(pickGame(body));
    }
    if (body.action === 'game') {
      const g = gameById(body.gameId);
      if (!g) return res.status(400).json({ error: { message: 'Unknown game.' } });
      const revealed = new Set(Array.isArray(body.revealedExhibits) ? body.revealedExhibits : []);
      return res.status(200).json({ game: sanitizeGame(g, revealed) });
    }
    if (body.action === 'reveal') {
      // on_request exhibit: reveal only if a trigger phrase matches.
      const g = gameById(body.gameId);
      if (!g) return res.status(400).json({ error: { message: 'Unknown game.' } });
      const ex = (g.exhibits || []).find(e => e.id === body.exhibitId);
      if (!ex) return res.status(400).json({ error: { message: 'Unknown exhibit.' } });
      const q = String(body.query || '').toLowerCase();
      const hit = (ex.triggers || []).some(t => q.indexOf(String(t).toLowerCase()) >= 0);
      if (ex.reveal !== 'on_request' || hit) return res.status(200).json({ revealed: true, exhibit: sanitizeExhibit(ex, new Set([ex.id])) });
      return res.status(200).json({ revealed: false });
    }
    if (body.action === 'grade') {
      if (await rateLimited(userId, sbUrl, sbKey, token)) return res.status(429).json({ error: { message: 'Too many requests. Please slow down.' } });
      const g = gameById(body.gameId);
      if (!g) return res.status(400).json({ error: { message: 'Unknown game.' } });
      const rec = fieldMap(g).get(String(body.fieldId));
      if (!rec) return res.status(400).json({ error: { message: 'Unknown field.' } });
      if (rec.input === 'justify') return res.status(200).json(await gradeGraphJustify(rec, body.value));
      if (rec.input === 'numeric') return res.status(200).json(gradeNumeric(rec, body.value));
      return res.status(200).json(gradeExact(rec, body.value)); // dropdown | choice
    }

    return res.status(400).json({ error: { message: 'Unknown action.' } });
  } catch (err) {
    console.error('CasEdge Redrock error:', err);
    return res.status(500).json({ error: { message: 'Something went wrong. Please try again.' } });
  }
}
