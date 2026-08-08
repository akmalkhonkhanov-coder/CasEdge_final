// CasEdge serverless proxy to the Anthropic API.
// Hardened: locked CORS, Supabase token verification, body limits,
// model allow-list, per-user rate limit, upstream timeouts, no error leakage.
//
// Required Vercel env vars:
//   ANTHROPIC_API_KEY   - your Anthropic key (already set)
//   SUPABASE_URL        - e.g. https://owyjiizhtrqpzlzawrjn.supabase.co
//   SUPABASE_ANON_KEY   - your Supabase anon/publishable key
//   ALLOWED_ORIGIN      - e.g. https://cas-edge-final.vercel.app
//                         (optional; falls back to the value below)

const { verifyUserCached, rateLimitedScoped } = require('./_auth.js');
const FALLBACK_ORIGIN = 'https://cas-edge-final.vercel.app';
const ALLOWED_MODELS = ['claude-sonnet-5', 'claude-sonnet-4-5'];
const MAX_TOKENS_CAP = 8000;       // hard ceiling; Russian feedback JSON is ~2x token-heavier than English
const MIN_TOKENS = 5000;           // floor so large JSON outputs (incl. Russian feedback) never truncate
// 2026-07-27. Пол в 5000 защищал ТЕКСТ от обрезания, но ничего не говорил про
// размышление — и модель тратила на него сколько хотела, а тарифицируется оно
// как выход. Явный бюджет: думание ограничено, весь остаток гарантированно
// достаётся JSON'у, ради которого пол и вводили.
// Форма управления размышлением. Замер 29.07: `thinking:{type:'enabled',
// budget_tokens}` эта модель НЕ принимает — апстрим отвечает 400 и называет
// замену: thinking.type.adaptive + output_config.effort. Пока стояла старая
// форма, каждый вызов делал два запроса: отвергнутый и откат, а размышление
// не ограничивалось вовсе.
const EFFORT_MODES = [
  { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } },
  { thinking: { type: 'adaptive' } },
  null
];
let _effortMode = 0;
const MAX_BODY_BYTES = 200 * 1024; // 200 KB request cap
const RATE_LIMIT = 30;             // requests per user per window
const RATE_WINDOW_MS = 60 * 1000;  // 1-minute window
const UPSTREAM_TIMEOUT_MS = 60 * 1000; // abort Anthropic call if it hangs
const AUTH_TIMEOUT_MS = 8 * 1000;      // abort Supabase auth check if it hangs

// Rate limiting is enforced via a Postgres function in Supabase
// (check_and_increment_rate_limit), so it's shared across every
// serverless instance instead of resetting on cold start.
async function rateLimited(userId, sbUrl, sbKey, token) {
  /* Ключ счётчика разведён по ручкам — см. api/_auth.js. До этого все
     восемь ручек делили одну строку, и порог 6 у транскрипции вместе
     с окном 300 секунд действовал на всех. */
  return rateLimitedScoped({ userId, scope: 'claude', limit: RATE_LIMIT,
    windowSeconds: RATE_WINDOW_MS / 1000, sbUrl, sbKey, token, timeoutMs: AUTH_TIMEOUT_MS });
}

// fetch() with an abort timeout so a hung upstream cannot keep the function
// (and its billing) alive indefinitely.
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
// Anthropic occasionally returns 429/529 ("overloaded") or 5xx during capacity
// spikes. Retry a few times with backoff so a transient blip never surfaces to
// the user as a failed scorecard/drill.
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
      lastErr = e;                       // network/abort — retry too
      if (attempt >= maxRetries) throw e;
    }
  }
  if (lastErr) throw lastErr;
}

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || FALLBACK_ORIGIN;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });

  try {
    // 1) Require a Supabase bearer token (cheap check, no network yet).
    const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: { message: 'Authentication required.' } });

    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_ANON_KEY;
    if (!sbUrl || !sbKey) {
      return res.status(500).json({ error: { message: 'Server auth not configured.' } });
    }

    // 2) Body size limit BEFORE any network call - reject oversized payloads early.
    const raw = JSON.stringify(req.body || {});
    if (raw.length > MAX_BODY_BYTES) {
      return res.status(413).json({ error: { message: 'Request too large.' } });
    }

    // 3) Одна проверка сессии на всё приложение — ./_auth.js, с кешем на инстанс.
    const user = await verifyUserCached(token, AUTH_TIMEOUT_MS);
    if (!user) return res.status(401).json({ error: { message: 'Invalid or expired session.' } });
    const userId = user.id;

    // 4) Per-user rate limit (after we know who the user is). Shared across
    // all serverless instances via Supabase - see check_and_increment_rate_limit.
    if (await rateLimited(userId, sbUrl, sbKey, token)) {
      return res.status(429).json({ error: { message: 'Too many requests. Please slow down.' } });
    }

    const body = req.body || {};

    // Model allow-list.
    if (body.model && !ALLOWED_MODELS.includes(body.model)) {
      return res.status(400).json({ error: { message: 'Model not permitted.' } });
    }
    body.model = ALLOWED_MODELS.includes(body.model) ? body.model : ALLOWED_MODELS[0];

    // max_tokens: give every response room to finish. The post-case feedback
    // returns a large JSON that was truncating at 1000-2000 tokens and failing
    // to JSON.parse ("Unterminated string"). Floor at MIN_TOKENS, cap at the
    // ceiling. Billing is on actual output tokens, so short replies (drills)
    // are unaffected.
    const reqTokens = (typeof body.max_tokens === 'number' && body.max_tokens > 0) ? body.max_tokens : 1000;
    body.max_tokens = Math.min(Math.max(reqTokens, MIN_TOKENS), MAX_TOKENS_CAP);
    if (!body.thinking && EFFORT_MODES[_effortMode]) Object.assign(body, EFFORT_MODES[_effortMode]);

    // 5) Prompt caching on the system prompt (saves ~70% on input tokens).
    if (body.system && typeof body.system === 'string') {
      body.system = [
        { type: 'text', text: body.system, cache_control: { type: 'ephemeral' } }
      ];
    }

    // 6) Forward to Anthropic (with a timeout + retry on transient overloads).
    const callModel = async (payload, timeoutMs, retries) => fetchAnthropicWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31'
      },
      body: JSON.stringify(payload)
    }, timeoutMs != null ? timeoutMs : UPSTREAM_TIMEOUT_MS, retries != null ? retries : 4);
    const textOf = (data) => (data && Array.isArray(data.content))
      ? data.content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
      : '';

    // Hard time budget: everything (call + optional thinking-retry) must fit
    // inside Vercel's 60s. One generous attempt; NO internal transient retries —
    // the client performs the full second attempt as a fresh invocation.
    const T0 = Date.now();
    const BUDGET_MS = 52 * 1000;
    let response;
    try {
      response = await callModel(body, 50 * 1000, 0);
      // Спускаемся по формам, пока апстрим не примет. Лучше дороже, чем
      // мёртвая скоркарта; каждый отказ печатается, молча не живёт.
      while (response.status === 400 && _effortMode < EFFORT_MODES.length - 1) {
        const txt = await response.clone().text().catch(() => '');
        if (!/thinking|output_config|effort/i.test(txt)) break;
        console.error('claude.js: effort mode', _effortMode, 'rejected —', txt.slice(0, 160));
        _effortMode++;
        delete body.thinking; delete body.output_config;
        if (EFFORT_MODES[_effortMode]) Object.assign(body, EFFORT_MODES[_effortMode]);
        response = await callModel(body, 50 * 1000, 0);
      }
    } catch (e) {
      return res.status(504).json({ error: { message: 'The grader is taking too long. Please try again.' } });
    }

    let data = await response.json();
    if (data && data.usage) {
      const u = data.usage;
      console.log('claude.js usage', JSON.stringify({
        in: u.input_tokens, out: u.output_tokens,
        cache_read: u.cache_read_input_tokens, cache_write: u.cache_creation_input_tokens,
        max: body.max_tokens, stop: data.stop_reason
      }));
    }
    // Rare failure mode: the model spends the entire max_tokens budget on a
    // thinking block and returns no text (stop_reason max_tokens). One
    // automatic retry with extra headroom fixes it.
    const timeLeft = BUDGET_MS - (Date.now() - T0);
    // ANY max_tokens stop is bad here — the JSON payload is truncated whether
    // text is empty (thinking ate it all) or partial (thinking ate half).
    if (response.status === 200 && data && data.stop_reason === 'max_tokens' && timeLeft > 15 * 1000) {
      console.error('claude.js: max_tokens truncation, retrying with 8000, timeLeft', timeLeft);
      try {
        const resp2 = await callModel({ ...body, max_tokens: 8000 }, timeLeft - 2000, 0);
        if (resp2.status === 200) {
          const data2 = await resp2.json();
          if (textOf(data2)) { data = data2; response = resp2; }
        }
      } catch (e) { /* keep original data */ }
    }
    // The model can return several content blocks (e.g. a thinking block before
    // the text). Clients read content[0].text, so collapse all text blocks into
    // one — otherwise callAI() sees an empty/first non-text block and drills and
    // the post-case feedback (JSON) silently fail to parse.
    {
      const text = textOf(data);
      if (text) data.content = [{ type: 'text', text }];
    }
    return res.status(response.status).json(data);
  } catch (err) {
    // Log the real error server-side (visible in Vercel logs), never leak it to the client.
    console.error('CasEdge proxy error:', err);
    return res.status(500).json({ error: { message: 'Something went wrong. Please try again.' } });
  }
}
