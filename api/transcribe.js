// CasEdge serverless proxy for voice-answer transcription (BCG Chat Game final
// recommendation step only). Mirrors the hardening pattern in api/claude.js:
// locked CORS, Supabase token verification, body size limit, per-user rate
// limit, upstream timeout, no error leakage.
//
// Required Vercel env vars (new, in addition to the ones claude.js uses):
//   OPENAI_API_KEY      - from platform.openai.com (separate from ANTHROPIC_API_KEY)
//   SUPABASE_URL        - already set for claude.js
//   SUPABASE_ANON_KEY   - already set for claude.js
//   ALLOWED_ORIGIN      - already set for claude.js
//
// Model: gpt-4o-transcribe (full, not mini) - chosen for accuracy on
// accented/mixed-language speech over the cheaper mini variant. Cost is
// $0.006/min either way, negligible next to per-session AI costs.

const FALLBACK_ORIGIN = 'https://cas-edge-final.vercel.app';
const TRANSCRIBE_MODEL = 'gpt-4o-transcribe';
const MAX_BODY_BYTES = 8 * 1024 * 1024;   // 8 MB - comfortably covers a ~2 min webm/opus clip as base64
const MAX_AUDIO_SECONDS = 150;            // hard cap candidates can record (2.5 min) - enforced client-side too
const RATE_LIMIT = 6;                     // transcriptions per user per window - this is one-per-final-question, not chat-turn volume
const RATE_WINDOW_MS = 5 * 60 * 1000;     // 5-minute window
const UPSTREAM_TIMEOUT_MS = 45 * 1000;
const AUTH_TIMEOUT_MS = 8 * 1000;

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Reuses the same Postgres RPC as claude.js (check_and_increment_rate_limit),
// just with a smaller limit/window suited to voice answers instead of chat turns.
async function rateLimited(userId, sbUrl, sbKey, token) {
  try {
    const resp = await fetchWithTimeout(sbUrl + '/rest/v1/rpc/check_and_increment_rate_limit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: sbKey, Authorization: 'Bearer ' + token },
      body: JSON.stringify({ p_user_id: userId, p_window_seconds: RATE_WINDOW_MS / 1000, p_limit: RATE_LIMIT })
    }, AUTH_TIMEOUT_MS);
    if (!resp.ok) { console.error('Rate-limit RPC returned', resp.status); return false; } // fail open, same reasoning as claude.js
    const withinLimit = await resp.json();
    return withinLimit === false;
  } catch (e) {
    console.error('Rate-limit RPC failed:', e);
    return false;
  }
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
    const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: { message: 'Authentication required.' } });

    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_ANON_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!sbUrl || !sbKey) return res.status(500).json({ error: { message: 'Server auth not configured.' } });
    if (!openaiKey) return res.status(500).json({ error: { message: 'Transcription is not configured on the server.' } });

    const raw = JSON.stringify(req.body || {});
    if (raw.length > MAX_BODY_BYTES) return res.status(413).json({ error: { message: 'Recording too large. Please keep answers under ' + Math.floor(MAX_AUDIO_SECONDS / 60) + ' minutes.' } });

    let userResp;
    try {
      userResp = await fetchWithTimeout(sbUrl + '/auth/v1/user', { headers: { apikey: sbKey, Authorization: 'Bearer ' + token } }, AUTH_TIMEOUT_MS);
    } catch (e) {
      return res.status(504).json({ error: { message: 'Authentication timed out. Please try again.' } });
    }
    if (!userResp.ok) return res.status(401).json({ error: { message: 'Invalid or expired session.' } });
    const user = await userResp.json();
    const userId = user && user.id;
    if (!userId) return res.status(401).json({ error: { message: 'Invalid session.' } });

    if (await rateLimited(userId, sbUrl, sbKey, token)) {
      return res.status(429).json({ error: { message: 'Too many recordings. Please wait a moment and try again.' } });
    }

    const body = req.body || {};
    const audioB64 = body.audio;
    const mime = typeof body.mime === 'string' && /^audio\//.test(body.mime) ? body.mime : 'audio/webm';
    if (!audioB64 || typeof audioB64 !== 'string') return res.status(400).json({ error: { message: 'No audio provided.' } });

    let audioBuffer;
    try {
      audioBuffer = Buffer.from(audioB64, 'base64');
    } catch (e) {
      return res.status(400).json({ error: { message: 'Invalid audio encoding.' } });
    }
    if (audioBuffer.length === 0) return res.status(400).json({ error: { message: 'Empty audio.' } });

    const ext = mime.includes('mp4') ? 'mp4' : mime.includes('wav') ? 'wav' : mime.includes('mpeg') ? 'mp3' : 'webm';
    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: mime }), 'answer.' + ext);
    form.append('model', TRANSCRIBE_MODEL);
    // Candidates answer in English to mirror the real BCG/McKinsey screening (see BCG_CASES note in
    // index.html), so we pin the language hint - this measurably reduces mis-transcription into other
    // languages when the candidate has a strong accent, without blocking auto-detection entirely if it's wrong.
    form.append('language', 'en');

    let response;
    try {
      response = await fetchWithTimeout('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + openaiKey },
        body: form
      }, UPSTREAM_TIMEOUT_MS);
    } catch (e) {
      return res.status(504).json({ error: { message: 'Transcription is taking too long. Please try again.' } });
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('OpenAI transcription error:', response.status, data);
      return res.status(response.status).json({ error: { message: (data.error && data.error.message) || 'Transcription failed.' } });
    }
    return res.status(200).json({ text: data.text || '' });
  } catch (err) {
    console.error('CasEdge transcribe proxy error:', err);
    return res.status(500).json({ error: { message: 'Something went wrong. Please try again.' } });
  }
}
