// CasEdge serverless proxy to the Anthropic API.
// Hardened: locked CORS, Supabase token verification, body limits,
// model allow-list, and a simple per-user rate limit.
//
// Required Vercel env vars:
//   ANTHROPIC_API_KEY   - your Anthropic key (already set)
//   SUPABASE_URL        - e.g. https://owyjiizhtrqpzlzawrjn.supabase.co
//   SUPABASE_ANON_KEY   - your Supabase anon/publishable key
//   ALLOWED_ORIGIN      - e.g. https://cas-edge-final.vercel.app
//                         (optional; falls back to the value below)

const FALLBACK_ORIGIN = 'https://cas-edge-final.vercel.app';
const ALLOWED_MODELS = ['claude-sonnet-4-5'];
const MAX_TOKENS_CAP = 2000;       // hard ceiling regardless of what the client asks
const MAX_BODY_BYTES = 200 * 1024; // 200 KB request cap
const RATE_LIMIT = 30;             // requests per user per window
const RATE_WINDOW_MS = 60 * 1000;  // 1-minute window

// In-memory rate-limit store. Resets on cold start; fine as a first line of
// defence. For stronger guarantees use Upstash/Redis later.
const hits = new Map();

function rateLimited(userId) {
  const now = Date.now();
  const rec = hits.get(userId);
  if (!rec || now - rec.start > RATE_WINDOW_MS) {
    hits.set(userId, { start: now, count: 1 });
    return false;
  }
  rec.count++;
  return rec.count > RATE_LIMIT;
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
    // 1) Require a Supabase bearer token and verify it.
    const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: { message: 'Authentication required.' } });

    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_ANON_KEY;
    if (!sbUrl || !sbKey) {
      return res.status(500).json({ error: { message: 'Server auth not configured.' } });
    }

    const userResp = await fetch(sbUrl + '/auth/v1/user', {
      headers: { apikey: sbKey, Authorization: 'Bearer ' + token }
    });
    if (!userResp.ok) {
      return res.status(401).json({ error: { message: 'Invalid or expired session.' } });
    }
    const user = await userResp.json();
    const userId = user && user.id;
    if (!userId) return res.status(401).json({ error: { message: 'Invalid session.' } });

    // 2) Per-user rate limit.
    if (rateLimited(userId)) {
      return res.status(429).json({ error: { message: 'Too many requests. Please slow down.' } });
    }

    // 3) Body size + shape limits.
    const raw = JSON.stringify(req.body || {});
    if (raw.length > MAX_BODY_BYTES) {
      return res.status(413).json({ error: { message: 'Request too large.' } });
    }

    const body = req.body || {};

    // Model allow-list.
    if (body.model && !ALLOWED_MODELS.includes(body.model)) {
      return res.status(400).json({ error: { message: 'Model not permitted.' } });
    }
    body.model = ALLOWED_MODELS.includes(body.model) ? body.model : ALLOWED_MODELS[0];

    // max_tokens ceiling.
    if (typeof body.max_tokens !== 'number' || body.max_tokens > MAX_TOKENS_CAP || body.max_tokens < 1) {
      body.max_tokens = Math.min(body.max_tokens || 1000, MAX_TOKENS_CAP);
    }

    // 4) Prompt caching on the system prompt (saves ~70% on input tokens).
    if (body.system && typeof body.system === 'string') {
      body.system = [
        { type: 'text', text: body.system, cache_control: { type: 'ephemeral' } }
      ];
    }

    // 5) Forward to Anthropic.
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}
