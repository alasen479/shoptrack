// ============================================================
// stripe-checkout.js — Netlify Function
// Creates a Stripe Checkout Session for ShopTrack subscription
//
// POST body: { bizId, plan, billingCycle, newExpiry, email, bizName }
// Returns:   { url } — redirect to Stripe hosted checkout page
//
// ENV VARS required:
//   STRIPE_SECRET_KEY        — sk_live_...
//   STRIPE_PUBLISHABLE_KEY   — pk_live_... (not used here, but documented)
//   SUPABASE_URL             — https://xxx.supabase.co
//   SUPABASE_SERVICE_KEY     — service_role key
// ============================================================

const https = require('https');

// ── Plan prices in USD cents (Stripe uses smallest currency unit) ──
// Premium: $18/mo (monthly) | $180/yr (annual, save 17%)
// XAF equivalent: ~11,000 XAF/mo at market rate
const PLAN_USD_CENTS = {
  Premium:      { monthly: 1800,  yearly: 18000 },   // $18/mo | $180/yr (save 17%)
  Free:         { monthly: 0,     yearly: 0     },   // free plan
  // Legacy aliases — all map to Premium pricing
  Starter:      { monthly: 1800,  yearly: 18000 },
  Professional: { monthly: 1800,  yearly: 18000 },
  Pro:          { monthly: 1800,  yearly: 18000 },
  Enterprise:   { monthly: 1800,  yearly: 18000 },
};

const PLAN_LABELS = {
  Premium:      'ShopTrack Premium',
  Free:         'ShopTrack Free',
  Starter:      'ShopTrack Premium',
  Professional: 'ShopTrack Premium',
  Pro:          'ShopTrack Premium',
  Enterprise:   'ShopTrack Premium',
};

function stripePost(path, params, secretKey) {
  return new Promise((resolve, reject) => {
    const body = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    const options = {
      hostname: 'api.stripe.com',
      path,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Stripe-Version': '2024-11-20',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) reject(parsed);
          else resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
  const APP_URL    = 'https://shoptrack.org';

  if (!STRIPE_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'STRIPE_SECRET_KEY not configured' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { bizId, plan, billingCycle, newExpiry, email, bizName } = body;
  if (!bizId || !plan || !newExpiry) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields: bizId, plan, newExpiry' }) };
  }

  const cycle     = billingCycle === 'yearly' ? 'yearly' : 'monthly';
  const planKey   = (plan === 'Free' || plan === 'free') ? 'Free' : 'Premium'; // all paid plans → Premium
  const prices    = PLAN_USD_CENTS[planKey] || PLAN_USD_CENTS.Starter;
  const amtCents  = prices[cycle];
  const label     = PLAN_LABELS[planKey] || 'ShopTrack';
  const cycleLabel = cycle === 'yearly' ? 'Annual' : 'Monthly';

  try {
    const session = await stripePost('/v1/checkout/sessions', {
      'mode':                           'payment',
      'payment_method_types[0]':        'card',
      'line_items[0][price_data][currency]':               'usd',
      'line_items[0][price_data][product_data][name]':     `${label} — ${cycleLabel}`,
      'line_items[0][price_data][product_data][description]': `ShopTrack subscription for ${bizName || bizId}. Extends to ${newExpiry}.`,
      'line_items[0][price_data][unit_amount]':            String(amtCents),
      'line_items[0][quantity]':        '1',
      'customer_email':                 email || '',
      'metadata[biz_id]':               bizId,
      'metadata[plan]':                 planKey,
      'metadata[billing_cycle]':        cycle,
      'metadata[new_expiry]':           newExpiry,
      'success_url':                    `${APP_URL}/?stripe_success=1&biz_id=${bizId}&expiry=${newExpiry}`,
      'cancel_url':                     `${APP_URL}/?stripe_cancel=1`,
    }, STRIPE_KEY);

    console.log(`[stripe-checkout] Session created for ${bizId} → ${planKey} ${cycle} $${amtCents/100} | expiry: ${newExpiry}`);
    return { statusCode: 200, headers, body: JSON.stringify({ url: session.url, sessionId: session.id }) };

  } catch (err) {
    console.error('[stripe-checkout] Error:', JSON.stringify(err));
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Stripe session creation failed', detail: err }) };
  }
};
