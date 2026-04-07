// ============================================================
// stripe-webhook.js — Netlify Function
// Handles Stripe webhook events for ShopTrack subscriptions
//
// Listens for: checkout.session.completed
// On success:  extends sub_expires in Supabase, sets plan, marks Active
//              also fires referral reward (same as campay-webhook)
//
// ENV VARS required:
//   STRIPE_WEBHOOK_SECRET    — whsec_...
//   STRIPE_SECRET_KEY        — sk_live_...
//   SUPABASE_URL             — https://xxx.supabase.co
//   SUPABASE_SERVICE_KEY     — service_role key
// ============================================================

const https = require('https');
const crypto = require('crypto');

// ── Supabase REST helper ──────────────────────────────────────
function supabaseQuery(baseUrl, key, method, table, filter, body) {
  return new Promise((resolve, reject) => {
    const path = `/rest/v1/${table}${filter ? '?' + filter : ''}`;
    const payload = body ? JSON.stringify(body) : null;

    const options = {
      hostname: new URL(baseUrl).hostname,
      path,
      method,
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal',
      },
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ ok: res.statusCode < 400, status: res.statusCode, data: parsed });
        } catch (e) { resolve({ ok: res.statusCode < 400, status: res.statusCode, data: {} }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Stripe signature verification ────────────────────────────
function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  try {
    const parts  = sigHeader.split(',').reduce((acc, part) => {
      const [k, v] = part.split('=');
      acc[k] = v;
      return acc;
    }, {});
    const ts     = parts['t'];
    const sig    = parts['v1'];
    if (!ts || !sig) return false;

    const signedPayload = `${ts}.${payload}`;
    const expected = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch (e) { return false; }
}

exports.handler = async (event) => {
  const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  const SUPABASE_URL   = process.env.SUPABASE_URL;
  const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[stripe-webhook] Missing Supabase env vars');
    return { statusCode: 500, body: 'Server configuration error' };
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  // ── Verify Stripe signature ─────────────────────────────────
  const sigHeader = event.headers['stripe-signature'];
  const rawBody   = event.body;

  if (WEBHOOK_SECRET && !verifyStripeSignature(rawBody, sigHeader, WEBHOOK_SECRET)) {
    console.warn('[stripe-webhook] Signature verification failed');
    return { statusCode: 400, body: 'Invalid signature' };
  }

  let stripeEvent;
  try { stripeEvent = JSON.parse(rawBody); }
  catch (e) { return { statusCode: 400, body: 'Invalid JSON' }; }

  console.log(`[stripe-webhook] Event: ${stripeEvent.type}`);

  // ── Handle checkout.session.completed ──────────────────────
  if (stripeEvent.type === 'checkout.session.completed') {
    const session  = stripeEvent.data.object;
    const meta     = session.metadata || {};
    const bizId    = meta.biz_id;
    const plan     = meta.plan     || 'Premium';
    const newExpiry = meta.new_expiry;
    const cycle    = meta.billing_cycle || 'monthly';
    const amtUSD   = ((session.amount_total || 0) / 100).toFixed(2);

    if (!bizId || !newExpiry) {
      console.warn('[stripe-webhook] Missing biz_id or new_expiry in metadata');
      return { statusCode: 200, body: 'OK (no action — missing metadata)' };
    }

    if (session.payment_status !== 'paid') {
      console.warn(`[stripe-webhook] Payment not completed: ${session.payment_status}`);
      return { statusCode: 200, body: 'OK (payment not paid)' };
    }

    console.log(`[stripe-webhook] Payment confirmed: ${bizId} | ${plan} | ${cycle} | $${amtUSD} | expiry: ${newExpiry}`);

    // ── Update business in Supabase ─────────────────────────
    const { ok, status } = await supabaseQuery(
      SUPABASE_URL, SUPABASE_KEY, 'PATCH', 'businesses',
      `id=eq.${encodeURIComponent(bizId)}`,
      {
        plan:              plan,
        sub_expires:       newExpiry,
        billing_cycle:     cycle,
        status:            'Active',
        sub_charge_status: 'PAID',
        sub_last_charge_ref: session.id,
        sub_pending_expiry: null,
        updated_at:        new Date().toISOString(),
      }
    );

    if (!ok) {
      console.error(`[stripe-webhook] Supabase update failed: HTTP ${status}`);
      return { statusCode: 500, body: 'Database update failed' };
    }

    console.log(`[stripe-webhook] Supabase updated: ${bizId} → ${plan} | expires ${newExpiry}`);

    // ── Referral reward (same as campay-webhook) ──────────────
    try {
      const { data: refBiz } = await supabaseQuery(
        SUPABASE_URL, SUPABASE_KEY, 'GET', 'businesses',
        `id=eq.${encodeURIComponent(bizId)}&select=referred_by,referral_months_earned`
      );
      const referrerId = refBiz && refBiz[0] && !refBiz[0].referral_months_earned
        ? refBiz[0].referred_by : null;

      if (referrerId) {
        const { data: referrerRows } = await supabaseQuery(
          SUPABASE_URL, SUPABASE_KEY, 'GET', 'businesses',
          `id=eq.${encodeURIComponent(referrerId)}&select=sub_expires`
        );
        if (referrerRows && referrerRows[0]) {
          const today = new Date().toISOString().slice(0, 10);
          const base  = referrerRows[0].sub_expires || today;
          const rd    = new Date((base >= today ? base : today) + 'T00:00:00');
          rd.setMonth(rd.getMonth() + 1);
          const newReferrerExpiry = rd.toISOString().slice(0, 10);

          await supabaseQuery(SUPABASE_URL, SUPABASE_KEY, 'PATCH', 'businesses',
            `id=eq.${encodeURIComponent(referrerId)}`,
            { sub_expires: newReferrerExpiry }
          );
          await supabaseQuery(SUPABASE_URL, SUPABASE_KEY, 'PATCH', 'businesses',
            `id=eq.${encodeURIComponent(bizId)}`,
            { referral_months_earned: 1 }
          );
          console.log(`[stripe-webhook] Referral reward: ${referrerId} extended to ${newReferrerExpiry}`);
        }
      }
    } catch (refErr) {
      console.warn('[stripe-webhook] Referral reward failed (non-blocking):', refErr.message);
    }


    // ── Affiliate commission: 20% first payment, 10% months 2-12 ──
    try {
      const { data: bizRows } = await supabaseQuery(
        SUPABASE_URL, SUPABASE_KEY, 'GET', 'businesses',
        `id=eq.${encodeURIComponent(bizId)}&select=affiliate_code,affiliate_payments_count`
      );
      const biz     = bizRows && bizRows[0];
      const affCode = biz && biz.affiliate_code;
      const payNum  = biz ? ((biz.affiliate_payments_count || 0) + 1) : 1;

      if (affCode && payNum <= 12) {
        const { data: affRows } = await supabaseQuery(
          SUPABASE_URL, SUPABASE_KEY, 'GET', 'affiliates',
          `affiliate_code=eq.${encodeURIComponent(affCode)}&select=id,commission_pct,total_earned_xaf,unpaid_xaf,conversions&status=eq.approved`
        );
        if (affRows && affRows[0] && affRows[0].id) {
          const aff    = affRows[0];
          const pct    = payNum === 1 ? 20 : 10;
          // Convert USD to XAF (approx 1 USD = 610 XAF)
          const amtXAF = Math.round(parseFloat(amtUSD) * 610);
          const earned = Math.round(amtXAF * pct / 100);

          await supabaseQuery(SUPABASE_URL, SUPABASE_KEY, 'PATCH', 'affiliates',
            `id=eq.${aff.id}`,
            {
              conversions:      payNum === 1 ? (aff.conversions || 0) + 1 : (aff.conversions || 0),
              total_earned_xaf: (aff.total_earned_xaf || 0) + earned,
              unpaid_xaf:       (aff.unpaid_xaf || 0) + earned,
            }
          );

          await supabaseQuery(SUPABASE_URL, SUPABASE_KEY, 'POST', 'affiliate_commissions', null, {
            affiliate_id:   aff.id,
            biz_id:         bizId,
            payment_num:    payNum,
            commission_pct: pct,
            amount_xaf:     amtXAF,
            earned_xaf:     earned,
            payment_ref:    session.id,
            paid_out:       false,
            created_at:     new Date().toISOString(),
          });

          const clearCode = payNum >= 12;
          await supabaseQuery(SUPABASE_URL, SUPABASE_KEY, 'PATCH', 'businesses',
            `id=eq.${encodeURIComponent(bizId)}`,
            {
              affiliate_payments_count: payNum,
              ...(clearCode ? { affiliate_code: null } : {}),
            }
          );

          console.log(`[stripe-webhook] Affiliate #${payNum}/12: ${affCode} +${earned} XAF (${pct}% of $${amtUSD})${clearCode ? ' — series complete' : ''}`);
        }
      }
    } catch (affErr) {
      console.warn('[stripe-webhook] Affiliate commission failed (non-blocking):', affErr.message);
    }

    // ── Write audit log ─────────────────────────────────────
    try {
      await supabaseQuery(SUPABASE_URL, SUPABASE_KEY, 'POST', 'audit_log', null, {
        id:         'AUD-STR-' + Date.now().toString(36).toUpperCase(),
        biz_id:     bizId,
        action:     'Stripe payment confirmed',
        detail:     `${session.id} — $${amtUSD} USD | ${plan} ${cycle} | expires ${newExpiry}`,
        actor:      'Stripe Webhook',
        created_at: new Date().toISOString(),
      });
    } catch (e) { console.warn('[stripe-webhook] Audit log failed:', e.message); }

    return { statusCode: 200, body: JSON.stringify({ received: true, bizId, plan, newExpiry }) };
  }

  // All other events — acknowledge receipt
  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
