// CasEdge Paddle webhook receiver.
// Verifies the Paddle-Signature header, then grants/revokes entitlements
// in Supabase's user_entitlements table using the service-role key
// (this endpoint is server-to-server only - never called from the browser).
//
// Required Vercel env vars (new, in addition to the ones claude.js uses):
//   PADDLE_WEBHOOK_SECRET     - from Paddle Dashboard > Developer Tools > Notifications > (your destination)
//   SUPABASE_SERVICE_ROLE_KEY - from Supabase > Project Settings > API (the SECRET service_role key,
//                                never the anon key - keep this out of the frontend entirely)
//
// Setup status (updated 2026-07-09):
//   [x] Paddle account verified, 4 products/prices created, PRICE_PLAN_MAP filled in below.
//   [ ] Create a webhook destination in Paddle pointing at
//       https://cas-edge-final.vercel.app/api/paddle-webhook
//       subscribed to at least: transaction.completed
//       (subscription.canceled/paused are handled defensively below but won't fire for
//       these one-time products - safe to leave subscribed or not, they're a no-op either way)
//   [ ] Copy that destination's signing secret into PADDLE_WEBHOOK_SECRET.
//   [ ] IMPORTANT: verify the `user_entitlements.period_end` column in Supabase allows NULL -
//       the three consumption-based plans (drills/starter/full) now write period_end: null.
//       If the column is NOT NULL, those inserts will fail silently (logged, not thrown) and
//       no entitlement will be granted. Run in Supabase SQL editor if needed:
//         ALTER TABLE user_entitlements ALTER COLUMN period_end DROP NOT NULL;

import crypto from 'crypto';

// Vercel must NOT parse the body for this route - signature verification
// requires the exact raw bytes Paddle sent.
export const config = { api: { bodyParser: false } };

// All four prices are ONE-TIME Paddle transactions (confirmed 2026-07-09), not subscriptions -
// there is no subscription object and Paddle never fires subscription.canceled/paused for these.
// periodDays is therefore null for the three consumption-based plans: they don't expire by date,
// they expire when cases_used/drills_used reach their cap (enforced by the app's rate-limit check,
// NOT by this webhook - this file only grants the initial cap). Game Pass is the one exception:
// it genuinely is time-boxed (2 months from purchase), so it keeps a real periodDays value.
const PRICE_PLAN_MAP = {
  'pri_01kx2wjymz8kv1y8azrf7st8zz': { plan: 'drills',   casesCap: 0,  drillsCap: 30, gamesCap: 0,  periodDays: null }, // Drills Only $10 - 30 drills, no expiry date
  'pri_01kx2whmgwkjaz0bqcn6g2415h': { plan: 'starter',  casesCap: 15, drillsCap: 20, gamesCap: 0,  periodDays: null }, // Starter Library $14 - 15 cases + 20 drills, no expiry date
  'pri_01kx2wdq460z7084wnmtebk3w3': { plan: 'full',     casesCap: 20, drillsCap: 30, gamesCap: 0,  periodDays: null }, // Full Library $18 - 20 cases + 30 drills, no expiry date
  'pri_01kx2wb5fb6r2gkkvsfk58dkd6': { plan: 'gamepass', casesCap: 0,  drillsCap: 0,  gamesCap: 75, periodDays: 60 },   // Game Pass $45 - 2-month window, up to 75 game sessions
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Manual HMAC-SHA256 verification per Paddle's documented algorithm:
// header format "ts=<unix_ts>;h1=<hex_sig>", signed payload "<ts>:<rawBody>".
function verifyPaddleSignature(rawBody, header, secret, toleranceSeconds = 30) {
  if (!header) return false;
  const match = /^ts=(\d+);h1=([0-9a-f]+)$/.exec(header);
  if (!match) return false;
  const ts = match[1];
  const h1 = match[2];
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > toleranceSeconds) return false; // reject stale/replayed events
  const signedPayload = `${ts}:${rawBody}`;
  const computed = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(h1, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  const sbUrl = process.env.SUPABASE_URL;
  const sbServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret || !sbUrl || !sbServiceKey) {
    console.error('Paddle webhook: missing required env vars');
    return res.status(500).end();
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    return res.status(400).end();
  }

  const signature = req.headers['paddle-signature'] || req.headers['Paddle-Signature'];
  if (!verifyPaddleSignature(rawBody, signature, secret)) {
    console.error('Paddle webhook: signature verification failed');
    return res.status(401).end();
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return res.status(400).end();
  }

  const eventType = event.event_type;
  const data = event.data || {};

  try {
    if (eventType === 'transaction.completed') {
      await handleEntitlementGrant(data, sbUrl, sbServiceKey);
    } else if (eventType === 'subscription.canceled' || eventType === 'subscription.paused') {
      await handleEntitlementRevoke(data, sbUrl, sbServiceKey);
    }
    // Other event types (subscription.created, transaction.updated, etc.)
    // are acknowledged with 200 but not acted on yet - add cases here as needed.
  } catch (e) {
    // Log but still return 200: a bug on our side shouldn't make Paddle
    // retry the same webhook forever. Fix and reprocess from the Paddle
    // dashboard's event log instead.
    console.error('Paddle webhook processing error:', e);
  }

  return res.status(200).json({ received: true });
}

async function handleEntitlementGrant(data, sbUrl, sbServiceKey) {
  // We pass our own Supabase user_id through custom_data at checkout time -
  // see the Paddle.Checkout.open({ customData: { userId } }) call on the frontend.
  const userId = data.custom_data && data.custom_data.userId;
  if (!userId) { console.error('Paddle webhook: no userId in custom_data'); return; }

  const items = data.items || [];
  const priceId = items[0] && items[0].price && items[0].price.id;
  const planCfg = PRICE_PLAN_MAP[priceId];
  if (!planCfg) { console.error('Paddle webhook: unrecognized price_id', priceId); return; }

  const txId = data.id || null;
  if (!txId) { console.error('Paddle webhook: transaction has no id'); return; }

  /* ─── 1. ИДЕМПОТЕНТНОСТЬ ────────────────────────────────────────────────
     Paddle ПОВТОРЯЕТ доставку вебхука, пока не получит 200. С прежней записью
     "поверх" повтор был безвреден: он писал те же самые предельные значения.
     С накоплением (см. пункт 2) тот же повтор УДВОИЛ БЫ купленное. Поэтому
     каждая выдача сперва отмечается в журнале выдач по transaction_id:
     первичный ключ отбивает второй заход механически, а не проверкой памяти. */
  const claim = await fetch(sbUrl + '/rest/v1/entitlement_grants', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: sbServiceKey,
      Authorization: 'Bearer ' + sbServiceKey,
      Prefer: 'return=minimal'
    },
    body: JSON.stringify({ transaction_id: txId, user_id: userId, plan: planCfg.plan })
  });
  if (claim.status === 409) {
    console.log('Paddle webhook: transaction ' + txId + ' already granted, skipping');
    return;
  }
  if (!claim.ok) {
    // Не выдаём права, если не смогли застолбить выдачу: лучше повтор от Paddle,
    // чем двойная выдача. Вернувшись без 200, мы попросим доставить ещё раз.
    console.error('Paddle webhook: grant claim failed', claim.status, await claim.text());
    throw new Error('grant claim failed');
  }

  /* ─── 2. НАКОПЛЕНИЕ, А НЕ ЗАМЕНА ─────────────────────────────────────────
     Прежняя запись клала cases_cap = cap ТЕКУЩЕЙ покупки и обнуляла *_used.
     Человек, купивший Starter (15 кейсов), потративший 10 и купивший затем
     Game Pass, получал cases_cap = 0 - пять оплаченных кейсов исчезали.
     Теперь пределы СКЛАДЫВАЮТСЯ, потраченное не трогается, а окно Game Pass
     берётся более поздним из двух. */
  const now = new Date();
  const periodEnd = planCfg.periodDays
    ? new Date(now.getTime() + planCfg.periodDays * 24 * 60 * 60 * 1000)
    : null;

  let prev = null;
  try {
    const r = await fetch(sbUrl + '/rest/v1/user_entitlements?user_id=eq.'
      + encodeURIComponent(userId) + '&select=cases_cap,drills_cap,games_cap,period_end,plan',
      { headers: { apikey: sbServiceKey, Authorization: 'Bearer ' + sbServiceKey } });
    if (r.ok) { const rows = await r.json(); prev = Array.isArray(rows) && rows[0] ? rows[0] : null; }
    else console.error('Paddle webhook: read existing entitlement failed', r.status);
  } catch (e) { console.error('Paddle webhook: read existing entitlement threw', e); }

  const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const prevEnd = prev && prev.period_end ? new Date(prev.period_end) : null;
  /* Более позднее из двух окон. Уже истёкшее окно не продлевает новое и
     не укорачивает его. */
  const mergedEnd = (() => {
    const cands = [prevEnd, periodEnd].filter(d => d && d.getTime() > now.getTime());
    if (!cands.length) return null;
    return new Date(Math.max.apply(null, cands.map(d => d.getTime())));
  })();

  const body = {
    user_id: userId,
    // Имя плана - последняя покупка. Права считаются по пределам, не по имени.
    plan: planCfg.plan,
    period_start: now.toISOString(),
    period_end: mergedEnd ? mergedEnd.toISOString() : null,
    cases_cap:  num(prev && prev.cases_cap)  + (planCfg.casesCap  || 0),
    drills_cap: num(prev && prev.drills_cap) + (planCfg.drillsCap || 0),
    games_cap:  num(prev && prev.games_cap)  + (planCfg.gamesCap  || 0),
    paddle_customer_id: data.customer_id || null,
    paddle_transaction_id: txId,
    status: 'active',
    updated_at: now.toISOString()
  };
  /* cases_used / drills_used / games_used НЕ ПЕРЕЧИСЛЯЮТСЯ здесь намеренно:
     merge-duplicates не трогает поля, которых нет в теле. Потраченное живёт
     своей жизнью, и настоящий счёт расхода ведёт таблица
     entitlement_consumption, а не эти колонки. */

  const resp = await fetch(sbUrl + '/rest/v1/user_entitlements?on_conflict=user_id', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: sbServiceKey,
      Authorization: 'Bearer ' + sbServiceKey,
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    console.error('Supabase entitlement grant failed:', resp.status, await resp.text());
    throw new Error('entitlement grant failed');
  }
  console.log('Paddle webhook: granted ' + planCfg.plan + ' to ' + userId
    + ' caps now ' + body.cases_cap + '/' + body.drills_cap + '/' + body.games_cap);
}

async function handleEntitlementRevoke(data, sbUrl, sbServiceKey) {
  const subId = data.id;
  if (!subId) return;
  const resp = await fetch(
    sbUrl + '/rest/v1/user_entitlements?paddle_subscription_id=eq.' + encodeURIComponent(subId),
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: sbServiceKey,
        Authorization: 'Bearer ' + sbServiceKey
      },
      body: JSON.stringify({ status: 'canceled', updated_at: new Date().toISOString() })
    }
  );
  if (!resp.ok) console.error('Supabase entitlement revoke failed:', resp.status, await resp.text());
}
