// netlify/functions/campay-webhook.js
// Receives real-time payment notifications from CamPay.
//
// CamPay calls this URL automatically when a payment is SUCCESSFUL or FAILED.
// Set this as your Callback URL in the CamPay dashboard (Webhook section):
//   https://shoptrack.org/.netlify/functions/campay-webhook
//
// ── Required env vars (Netlify → Site configuration → Environment variables) ──
//
//   CAMPAY_WEBHOOK_KEY    → "App Webhook Key" from CamPay dashboard (API ACCESS KEYS section)
//                           Copy it exactly — CamPay sends it as X-Campay-Signature on every call.
//   SUPABASE_URL          → Your Supabase project URL (e.g. https://xxxx.supabase.co)
//   SUPABASE_SERVICE_KEY  → Supabase service_role key (Settings → API → service_role)
//                           NOT the anon key — the service key bypasses RLS for server-side updates.
//
// ── CamPay webhook payload ────────────────────────────────────
//   {
//     "reference":          "CAMPAY-REF-XXXX",       ← CamPay's own transaction ID
//     "status":             "SUCCESSFUL" | "FAILED",
//     "amount":             5000,                     ← integer XAF
//     "currency":           "XAF",
//     "operator":           "MTN" | "Orange",
//     "operator_reference": "MTN-TXN-XXXXXX",        ← carrier's own ID
//     "external_reference": "S-123456",              ← your ShopTrack sale/rental/appt ID
//     "description":        "Payment to ShopTrack",
//     "timestamp":          "2026-01-15T10:30:00Z"
//   }
//
// ── What this webhook does ────────────────────────────────────
//   1. Validates the App Webhook Key header
//   2. Matches external_reference to a ShopTrack sale / rental / appointment
//   3. Updates the payment record in Supabase
//   4. Adjusts the customer's balance (AR)
//   5. Writes an entry to the audit_log table
//   Always returns HTTP 200 — returning 4xx/5xx causes CamPay to retry endlessly

'use strict';


// ── Supabase REST helper (no SDK needed) ──────────────────────
async function supabaseQuery(url, key, method, table, filter, update) {
  const endpoint = `${url}/rest/v1/${table}${filter ? '?' + filter : ''}`;
  const res = await fetch(endpoint, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        key,
      'Authorization': `Bearer ${key}`,
      'Prefer':        'return=representation',
    },
    body: update ? JSON.stringify(update) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = []; }
  return { ok: res.ok, status: res.status, data };
}

exports.handler = async function (event) {
  const headers = {
    'Content-Type': 'application/json',
  };

  // CamPay only sends POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const WEBHOOK_KEY     = process.env.CAMPAY_WEBHOOK_KEY;   // "App Webhook Key" from CamPay dashboard
  const SUPABASE_URL    = process.env.SUPABASE_URL;
  const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[campay-webhook] SUPABASE_URL or SUPABASE_SERVICE_KEY not set');
    // Still return 200 to CamPay so it doesn't keep retrying
    return { statusCode: 200, headers, body: JSON.stringify({ received: true }) };
  }

  // ── Verify the App Webhook Key ────────────────────────────
  // CamPay sends the App Webhook Key value in the X-Campay-Signature header.
  // We compare it directly (it is not an HMAC — it is the key itself).
  const incomingKey = event.headers['x-campay-signature'] || '';

  if (WEBHOOK_KEY) {
    if (incomingKey !== WEBHOOK_KEY) {
      console.warn('[campay-webhook] Webhook key mismatch — rejecting request');
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid webhook key' }) };
    }
  } else {
    console.warn('[campay-webhook] CAMPAY_WEBHOOK_KEY not set — skipping key check. Set it in Netlify env vars.');
  }

  // ── Parse payload ─────────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    console.error('[campay-webhook] Invalid JSON body');
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const {
    reference,          // CamPay's reference (store this for reconciliation)
    status,             // SUCCESSFUL | FAILED
    amount,             // amount in XAF (integer)
    operator,           // MTN | Orange
    operator_reference, // the carrier's own transaction ID
    external_reference, // our ShopTrack ID (sale ID, rental ID, or appt ID)
    timestamp,
  } = payload;

  console.log(`[campay-webhook] received | ref=${reference} | ext_ref=${external_reference} | status=${status} | amount=${amount} XAF`);

  // We only act on SUCCESSFUL payments — FAILED ones need no DB update
  if (status !== 'SUCCESSFUL') {
    console.log(`[campay-webhook] status=${status} — no DB action needed`);
    return { statusCode: 200, headers, body: JSON.stringify({ received: true }) };
  }

  if (!external_reference) {
    console.warn('[campay-webhook] No external_reference in payload — cannot match to ShopTrack record');
    return { statusCode: 200, headers, body: JSON.stringify({ received: true }) };
  }

  // ── Convert XAF to USD for storage ───────────────────────
  // ShopTrack stores all monetary values in USD.
  // XAF/USD rate — we use a fixed approximate rate.
  // In production you may want to store the XAF amount directly instead.
  // At time of writing: 1 USD ≈ 615 XAF (CEMAC fixed rate zone)
  const XAF_TO_USD_RATE = 615;
  const amountUsd = Math.round((amount / XAF_TO_USD_RATE) * 10000) / 10000;

  const extRef = String(external_reference).trim();
  const isSale   = extRef.startsWith('S-');
  const isRental = extRef.startsWith('R-');
  const isAppt   = extRef.startsWith('APT-') || extRef.startsWith('A-');
  // Subscription charges use the pattern SUB-BIZ-XXX-YYYYMMDD-XXXX
  const isSub    = extRef.startsWith('SUB-');

  // Payment metadata to record
  const paymentMeta = {
    campay_ref:      reference,
    operator,
    operator_ref:    operator_reference || null,
    paid_at:         timestamp || new Date().toISOString(),
    amount_xaf:      amount,
    amount_usd:      amountUsd,
  };

  let bizId = null;
  let updated = false;

  // ── Update sale record ────────────────────────────────────
  if (isSale) {
    const { ok, data: rows } = await supabaseQuery(
      SUPABASE_URL, SUPABASE_KEY, 'GET', 'sales',
      `id=eq.${encodeURIComponent(extRef)}&select=*`
    );

    if (ok && rows && rows.length > 0) {
      const sale     = rows[0];
      bizId          = sale.biz_id;
      const prevPaid = sale.paid || 0;
      const total    = sale.total || sale.amount || 0;
      const newPaid  = Math.min(total, prevPaid + amountUsd);
      const newStatus = newPaid >= total ? 'Paid' : newPaid > 0 ? 'Partial' : 'Unpaid';

      await supabaseQuery(SUPABASE_URL, SUPABASE_KEY, 'PATCH', 'sales',
        `id=eq.${encodeURIComponent(extRef)}`,
        {
          paid:          newPaid,
          status:        newStatus,
          payment_meta:  paymentMeta,
          updated_at:    new Date().toISOString(),
        }
      );
      updated = true;
      console.log(`[campay-webhook] sale ${extRef} updated → paid=${newPaid} status=${newStatus}`);

      // Update customer balance (AR)
      if (sale.customer_name || sale.cust) {
        const custName = sale.customer_name || sale.cust;
        const applied  = newPaid - prevPaid;
        const { data: custRows } = await supabaseQuery(
          SUPABASE_URL, SUPABASE_KEY, 'GET', 'customers',
          `biz_id=eq.${bizId}&name=eq.${encodeURIComponent(custName)}&select=*`
        );
        if (custRows && custRows.length > 0) {
          const cust   = custRows[0];
          const newBal = Math.max(0, (cust.balance || 0) - applied);
          await supabaseQuery(SUPABASE_URL, SUPABASE_KEY, 'PATCH', 'customers',
            `id=eq.${cust.id}`,
            { balance: newBal, updated_at: new Date().toISOString() }
          );
        }
      }
    } else {
      console.warn(`[campay-webhook] Sale ${extRef} not found in Supabase`);
    }
  }

  // ── Update rental record ──────────────────────────────────
  else if (isRental) {
    const { ok, data: rows } = await supabaseQuery(
      SUPABASE_URL, SUPABASE_KEY, 'GET', 'rentals',
      `id=eq.${encodeURIComponent(extRef)}&select=*`
    );

    if (ok && rows && rows.length > 0) {
      const rental   = rows[0];
      bizId          = rental.biz_id;
      const prevPaid = rental.paid || 0;
      const fee      = rental.fee  || 0;
      const newPaid  = prevPaid + amountUsd;
      const newStatus = (rental.deposit || 0) + newPaid >= fee
        ? (rental.status === 'Returned' ? 'Returned' : 'Checked Out')
        : rental.status;

      await supabaseQuery(SUPABASE_URL, SUPABASE_KEY, 'PATCH', 'rentals',
        `id=eq.${encodeURIComponent(extRef)}`,
        {
          paid:         newPaid,
          status:       newStatus,
          payment_meta: paymentMeta,
          updated_at:   new Date().toISOString(),
        }
      );
      updated = true;
      console.log(`[campay-webhook] rental ${extRef} updated → paid=${newPaid}`);
    } else {
      console.warn(`[campay-webhook] Rental ${extRef} not found in Supabase`);
    }
  }

  // ── Update appointment record ─────────────────────────────
  else if (isAppt) {
    const { ok, data: rows } = await supabaseQuery(
      SUPABASE_URL, SUPABASE_KEY, 'GET', 'appointments',
      `id=eq.${encodeURIComponent(extRef)}&select=*`
    );

    if (ok && rows && rows.length > 0) {
      const appt  = rows[0];
      bizId       = appt.biz_id;
      const newPaid = (appt.paid || 0) + amountUsd;

      await supabaseQuery(SUPABASE_URL, SUPABASE_KEY, 'PATCH', 'appointments',
        `id=eq.${encodeURIComponent(extRef)}`,
        {
          paid:         newPaid,
          payment_meta: paymentMeta,
          updated_at:   new Date().toISOString(),
        }
      );
      updated = true;
      console.log(`[campay-webhook] appointment ${extRef} updated → paid=${newPaid}`);
    } else {
      console.warn(`[campay-webhook] Appointment ${extRef} not found in Supabase`);
    }
  }

  // ── Update subscription charge record ─────────────────────
  // SUB-BIZ-XXX-YYYYMMDD-XXXX — subscription payment from billing engine
  else if (isSub) {
    // Look up the subscription_charges record to get bizId and newExpiry
    const { ok: scOk, data: scRows } = await supabaseQuery(
      SUPABASE_URL, SUPABASE_KEY, 'GET', 'subscription_charges',
      `campay_ref=eq.${encodeURIComponent(reference)}&select=*`
    );

    if (scOk && scRows && scRows.length > 0) {
      const charge = scRows[0];
      bizId        = charge.biz_id;

      // Mark charge as SUCCESSFUL
      await supabaseQuery(SUPABASE_URL, SUPABASE_KEY, 'PATCH', 'subscription_charges',
        `campay_ref=eq.${encodeURIComponent(reference)}`,
        { status: 'SUCCESSFUL', confirmed_at: new Date().toISOString() }
      );

      // Calculate new subscription expiry
      // If the charge record has a newExpiry (from self-service Pay Now), use it directly
      // Otherwise calculate +1 month from the current sub_expires
      let newSubExpiry = charge.new_expiry || null;

      if (!newSubExpiry) {
        // Fetch current sub_expires from businesses table
        const { data: bizRows } = await supabaseQuery(
          SUPABASE_URL, SUPABASE_KEY, 'GET', 'businesses',
          `id=eq.${encodeURIComponent(bizId)}&select=sub_expires,trial_end`
        );
        const currentExpiry = bizRows && bizRows[0]
          ? (bizRows[0].sub_expires || bizRows[0].trial_end)
          : null;
        const today = new Date().toISOString().slice(0, 10);
        const base  = currentExpiry && currentExpiry >= today ? currentExpiry : today;
        const d = new Date(base + 'T00:00:00');
        d.setMonth(d.getMonth() + 1);
        newSubExpiry = d.toISOString().slice(0, 10);
      }

      // Update the business: extend subscription, mark as Active, clear pending status
      await supabaseQuery(SUPABASE_URL, SUPABASE_KEY, 'PATCH', 'businesses',
        `id=eq.${encodeURIComponent(bizId)}`,
        {
          sub_expires:         newSubExpiry,
          status:              'Active',
          sub_charge_status:   'PAID',
          sub_last_charge_ref: reference,
          sub_pending_expiry:  null,
          updated_at:          new Date().toISOString(),
        }
      );

      updated = true;
      console.log(`[campay-webhook] subscription ${extRef} confirmed → biz=${bizId} | new expiry=${newSubExpiry} | ${amount} XAF via ${operator}`);

      // ── Referral reward: if this biz was referred, give referrer 1 free month ──────
      // Only on first payment (referral_months_earned === 0)
      try {
        const { data: refBiz } = await supabaseQuery(
          SUPABASE_URL, SUPABASE_KEY, 'GET', 'businesses',
          `id=eq.${encodeURIComponent(bizId)}&select=referred_by,referral_months_earned`
        );
        const referrerId = refBiz && refBiz[0] && !refBiz[0].referral_months_earned
          ? refBiz[0].referred_by : null;

        if (referrerId) {
          // Fetch referrer's current sub_expires
          const { data: referrerRows } = await supabaseQuery(
            SUPABASE_URL, SUPABASE_KEY, 'GET', 'businesses',
            `id=eq.${encodeURIComponent(referrerId)}&select=sub_expires,name`
          );
          if (referrerRows && referrerRows[0]) {
            const referrerExp = referrerRows[0].sub_expires;
            const today = new Date().toISOString().slice(0, 10);
            const base = referrerExp && referrerExp >= today ? referrerExp : today;
            const rd = new Date(base + 'T00:00:00');
            rd.setMonth(rd.getMonth() + 1);
            const newReferrerExpiry = rd.toISOString().slice(0, 10);

            // Extend referrer's subscription by 1 month
            await supabaseQuery(SUPABASE_URL, SUPABASE_KEY, 'PATCH', 'businesses',
              `id=eq.${encodeURIComponent(referrerId)}`,
              { sub_expires: newReferrerExpiry }
            );
            // Mark as earned so it only fires once
            await supabaseQuery(SUPABASE_URL, SUPABASE_KEY, 'PATCH', 'businesses',
              `id=eq.${encodeURIComponent(bizId)}`,
              { referral_months_earned: 1 }
            );
            console.log(`[campay-webhook] Referral reward: ${referrerId} extended to ${newReferrerExpiry} (referred by ${bizId})`);
          }
        }
      } catch (refErr) {
        console.warn('[campay-webhook] Referral reward failed (non-blocking):', refErr.message);
      }

    } else {
      // Charge record not found by campay_ref — try finding by external_reference (the SUB-... ref)
      console.warn(`[campay-webhook] Subscription charge not found by campay_ref=${reference} — trying external_reference`);
      const { ok: scOk2, data: scRows2 } = await supabaseQuery(
        SUPABASE_URL, SUPABASE_KEY, 'GET', 'subscription_charges',
        `id=eq.${encodeURIComponent(extRef)}&select=*`
      );
      if (scOk2 && scRows2 && scRows2.length > 0) {
        bizId = scRows2[0].biz_id;
        const today2 = new Date().toISOString().slice(0, 10);
        const d2 = new Date(today2 + 'T00:00:00');
        d2.setMonth(d2.getMonth() + 1);
        const newExpiry2 = scRows2[0].new_expiry || d2.toISOString().slice(0, 10);
        await supabaseQuery(SUPABASE_URL, SUPABASE_KEY, 'PATCH', 'businesses',
          `id=eq.${encodeURIComponent(bizId)}`,
          { sub_expires: newExpiry2, status: 'Active', sub_charge_status: 'PAID', sub_pending_expiry: null }
        );
        await supabaseQuery(SUPABASE_URL, SUPABASE_KEY, 'PATCH', 'subscription_charges',
          `id=eq.${encodeURIComponent(extRef)}`,
          { status: 'SUCCESSFUL', confirmed_at: new Date().toISOString() }
        );
        updated = true;
        console.log(`[campay-webhook] subscription ${extRef} confirmed (fallback) → biz=${bizId} | new expiry=${newExpiry2}`);
      } else {
        console.warn(`[campay-webhook] Could not find subscription charge for ref=${extRef}`);
      }
    }
  }


  // ── Affiliate commission: 20% first payment, 10% months 2-12 ──
  if (updated && bizId) {
    try {
      const paymentRef = reference || extRef || '';

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
          // Use DB commission_pct for payment 1; half rate for renewals (2-12)
          const basePct = aff.commission_pct || 20;
          const pct    = payNum === 1 ? basePct : Math.round(basePct / 2);
          const earned = Math.round(amount * pct / 100);

          // Update affiliate running totals
          await supabaseQuery(SUPABASE_URL, SUPABASE_KEY, 'PATCH', 'affiliates',
            `id=eq.${aff.id}`,
            {
              conversions:      payNum === 1 ? (aff.conversions || 0) + 1 : (aff.conversions || 0),
              total_earned_xaf: (aff.total_earned_xaf || 0) + earned,
              unpaid_xaf:       (aff.unpaid_xaf || 0) + earned,
            }
          );

          // Log commission row
          await supabaseQuery(SUPABASE_URL, SUPABASE_KEY, 'POST', 'affiliate_commissions', null, {
            affiliate_id:   aff.id,
            biz_id:         bizId,
            payment_num:    payNum,
            commission_pct: pct,
            amount_xaf:     amount,
            earned_xaf:     earned,
            payment_ref:    paymentRef,
            paid_out:       false,
            created_at:     new Date().toISOString(),
          });

          // Increment payment count; clear affiliate_code after payment 12
          const clearCode = payNum >= 12;
          await supabaseQuery(SUPABASE_URL, SUPABASE_KEY, 'PATCH', 'businesses',
            `id=eq.${encodeURIComponent(bizId)}`,
            {
              affiliate_payments_count: payNum,
              ...(clearCode ? { affiliate_code: null } : {}),
            }
          );

          console.log(`[campay-webhook] Affiliate #${payNum}/12: ${affCode} +${earned} XAF (${pct}% of ${amount} XAF)${clearCode ? ' — series complete' : ''}`);
        }
      }
    } catch (affErr) {
      console.warn('[campay-webhook] Affiliate commission failed (non-blocking):', affErr.message);
    }
  }

  // ── Write audit log entry ─────────────────────────────────
  if (updated && bizId) {
    const actionLabel = isSub ? 'Subscription payment confirmed' : 'CamPay payment confirmed';
    const auditEntry = {
      id:         'AUD-' + Date.now().toString(36).toUpperCase(),
      biz_id:     bizId,
      action:     actionLabel,
      detail:     `${extRef} — ${amount} XAF via ${operator} | CamPay ref: ${reference}`,
      actor:      'CamPay Webhook',
      created_at: new Date().toISOString(),
    };
    await supabaseQuery(SUPABASE_URL, SUPABASE_KEY, 'POST', 'audit_log', null, auditEntry);
  }

  // Always return 200 to CamPay — if we return 4xx/5xx, CamPay retries
  return {
    statusCode: 200, headers,
    body: JSON.stringify({ received: true, processed: updated }),
  };
};
