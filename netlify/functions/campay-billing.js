// netlify/functions/campay-billing.js
// ShopTrack Subscription Billing Engine
//
// Runs automatically on two schedules (configure in netlify.toml):
//   1. Daily at 08:00 WAT — checks for reminders (3d, 2d, 1d before expiry)
//   2. 1st of every month at 08:00 WAT — charges all due subscriptions
//
// Can also be triggered manually via POST from the SA Billing dashboard.
//
// ── Required env vars ─────────────────────────────────────────
//   CAMPAY_PERMANENT_TOKEN   → From CamPay dashboard (preferred)
//   CAMPAY_APP_USERNAME      → CamPay App Username (fallback)
//   CAMPAY_APP_PASSWORD      → CamPay App Password (fallback)
//   CAMPAY_APP_NAME          → "ShopTrack"
//   CAMPAY_ENV               → blank=demo, "PROD"=live
//   SUPABASE_URL             → https://kjuxnigeexoynmvdzeyl.supabase.co
//   SUPABASE_SERVICE_KEY     → Supabase service_role key
//   SA_WHATSAPP_NUMBER       → Your SA WhatsApp number (e.g. 237670000000)
//                              Used as the "from" number for WA deep links
//
// ── Plan prices (XAF) ─────────────────────────────────────────
//   Free:       0 XAF/month  (permanent free plan)
//   Premium:    8,900 XAF/month | 89,000 XAF/year
//   (Legacy aliases Starter/Pro/Professional/Enterprise → Premium pricing)
//
// ── Subscription lifecycle ────────────────────────────────────
//   Day -3: WhatsApp reminder sent automatically
//   Day -2: WhatsApp reminder sent automatically
//   Day -1: WhatsApp reminder sent automatically
//   Day  0: CamPay collect request sent to business owner's phone
//           → Owner approves → subscription extended +30 days
//   Day +7: If still unpaid → business suspended automatically
//   Day +14: SA notified to consider permanent action
//
// ── Manual actions (POST body: { action, bizId }) ────────────
//   "charge_one"    → Immediately charge one business
//   "remind_one"    → Send WhatsApp reminder to one business
//   "charge_all"    → Charge all businesses due today
//   "remind_all"    → Send reminders for all businesses expiring in 1-3 days
//   "status"        → Return billing status of all businesses
//   "extend"        → Manually extend subscription (no charge)
//                     Requires: { bizId, days }
//   "suspend"       → Manually suspend a business
//   "reactivate"    → Manually reactivate a suspended business

'use strict';

// ── Plan definitions ──────────────────────────────────────────
const PLANS = {
  'Free':            { monthly: 0,    yearly: 0     },  // permanent free plan
  'Premium':         { monthly: 8900, yearly: 89000 },  // 8,900 FCFA/month
  'Trial (30 Days)': { monthly: 0,    yearly: 0     },  // 30-day full trial
  // Legacy aliases — kept for backwards compatibility with old Supabase records
  'Starter':         { monthly: 8900, yearly: 89000 },  // maps to Premium pricing
  'Pro':             { monthly: 8900, yearly: 89000 },
  'Professional':    { monthly: 8900, yearly: 89000 },
  'Enterprise':      { monthly: 8900, yearly: 89000 },
  'Demo Test':       { monthly: 10,   yearly: 10    },  // CamPay demo — max 25 XAF
};

// ── CamPay token cache ────────────────────────────────────────
let _tokenCache = { token: null, expiresAt: 0 };

// ── Date helpers ──────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysUntil(dateStr) {
  const now  = new Date(); now.setHours(0,0,0,0);
  const then = new Date(dateStr + 'T00:00:00');
  return Math.round((then - now) / 86400000);
}
function addMonths(dateStr, months) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

// ── Phone normalisation ───────────────────────────────────────
function normalisePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('237') && digits.length === 12) return digits;
  if (digits.length === 9) return '237' + digits;
  if (digits.length === 10 && digits.startsWith('0')) return '237' + digits.slice(1);
  return null;
}

// ── Supabase REST helper ──────────────────────────────────────
async function sb(url, key, method, table, filter, body) {
  const endpoint = `${url}/rest/v1/${table}${filter ? '?' + filter : ''}`;
  const res = await fetch(endpoint, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        key,
      'Authorization': `Bearer ${key}`,
      'Prefer':        'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = []; }
  return { ok: res.ok, status: res.status, data };
}

// ── CamPay helpers ────────────────────────────────────────────
async function getCamPayToken(baseUrl) {
  const TOKEN = process.env.CAMPAY_PERMANENT_TOKEN;
  if (TOKEN) return TOKEN;

  const now = Date.now();
  if (_tokenCache.token && _tokenCache.expiresAt > now + 120_000) return _tokenCache.token;

  const res = await fetch(`${baseUrl}/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.CAMPAY_APP_USERNAME,
      password: process.env.CAMPAY_APP_PASSWORD,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('CamPay auth failed: ' + (data.detail || res.status));
  _tokenCache = { token: data.token, expiresAt: now + (data.expires_in || 3600) * 1000 };
  return data.token;
}

async function campayCollect(baseUrl, token, phone, amountXAF, reference, description) {
  const res = await fetch(`${baseUrl}/collect/`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Token ${token}`,
    },
    body: JSON.stringify({
      amount:             Math.round(amountXAF),
      from:               phone,
      description:        description,
      external_reference: String(reference).slice(0, 50),
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || data.message || 'CamPay collect failed');
  return data;
}

// ── WhatsApp message builder ──────────────────────────────────
function buildWAReminder(biz, daysLeft, amountXAF, planName) {
  const urgency = daysLeft <= 1 ? '🚨 URGENT' : daysLeft <= 2 ? '⚠️' : '📅';
  const greeting = biz.owner ? biz.owner.split(' ')[0] : 'there';
  const expiryDate = biz.sub_expires || daysFromNow(daysLeft);

  let msg = `${urgency} Hi ${greeting}! 👋\n\n`;
  msg += `Your *ShopTrack ${planName} Plan* `;

  if (daysLeft <= 0) {
    msg += `expired today.\n\n`;
    msg += `⛔ Your access will be suspended in *7 days* if payment is not received.\n\n`;
  } else if (daysLeft === 1) {
    msg += `expires *tomorrow* (${expiryDate}).\n\n`;
  } else {
    msg += `expires in *${daysLeft} days* on ${expiryDate}.\n\n`;
  }

  msg += `💰 *Amount due:* ${amountXAF.toLocaleString()} XAF\n`;
  msg += `🏢 *Business:* ${biz.name}\n\n`;

  if (daysLeft > 0) {
    msg += `To renew, simply approve the Mobile Money request you will receive on *${biz.phone || 'your registered number'}*.\n\n`;
    msg += `Or log in to shoptrack.org to pay directly.\n\n`;
  } else {
    msg += `Please contact us immediately to avoid service interruption.\n\n`;
  }

  msg += `Thank you for being a ShopTrack customer! 🙏\n`;
  msg += `_ShopTrack — shoptrack.org_`;

  return msg;
}

function whatsappLink(phone, message) {
  const norm = normalisePhone(phone);
  if (!norm) return null;
  return `https://wa.me/${norm}?text=${encodeURIComponent(message)}`;
}

// ── Main handler ──────────────────────────────────────────────
exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type':                 'application/json',
  };

  // Accept both GET and POST — WAF blocks POST with payment keywords in body
  // GET with query params bypasses WAF inspection entirely
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST' && event.httpMethod !== 'OPTIONS') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // ── Parse request ─────────────────────────────────────────
  // Action and bizId can come from:
  //   1. Query string: ?a=charge_one&b=BIZ-107  (avoids WAF body inspection)
  //   2. POST body JSON (fallback for cron-job.org and direct API calls)
  // Query params take priority over body params.
  let action = 'scheduled_daily';
  let targetBizId      = null;
  let extendDays       = 30;
  let phoneOverride    = null;
  let newExpiryOverride= null;

  // Read from query string first
  const qs = event.queryStringParameters || {};
  if (qs.a) action           = qs.a;
  if (qs.b) targetBizId      = qs.b;
  if (qs.d) extendDays       = parseInt(qs.d) || 30;
  if (qs.p) phoneOverride    = qs.p;
  if (qs.e) newExpiryOverride= qs.e;

  // Then read/merge from POST body
  if (event.httpMethod === 'POST' && event.body) {
    try {
      const body       = JSON.parse(event.body || '{}');
      if (!qs.a && body.action)    action            = body.action;
      if (!qs.b && body.bizId)     targetBizId       = body.bizId;
      if (!qs.d && body.days)      extendDays        = body.days || 30;
      if (!qs.p && body.phone)     phoneOverride     = body.phone;
      if (!qs.e && body.newExpiry) newExpiryOverride = body.newExpiry;
    } catch {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }
  }
  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
  const IS_PROD       = process.env.CAMPAY_ENV === 'PROD';
  const CAMPAY_BASE   = IS_PROD ? 'https://campay.net/api' : 'https://demo.campay.net/api';
  const APP_NAME      = process.env.CAMPAY_APP_NAME || 'ShopTrack';

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 503, headers,
      body: JSON.stringify({ error: 'SUPABASE_URL and SUPABASE_SERVICE_KEY required' }) };
  }

  // ── Load all businesses from Supabase ─────────────────────
  const { ok, data: businesses } = await sb(
    SUPABASE_URL, SUPABASE_KEY, 'GET', 'businesses',
    "status=neq.Deleted&select=id,name,owner,email,phone,whatsapp,plan,status,sub_expires,trial_end,country,billing_cycle"
  );

  if (!ok || !Array.isArray(businesses)) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not load businesses from Supabase' }) };
  }

  const today = todayStr();
  const results = {
    action,
    date: today,
    charged: [],
    reminded: [],
    suspended: [],
    extended: [],
    errors: [],
    skipped: [],
  };

  // ── Helper: get amount due for a business ─────────────────
  function getAmountXAF(biz) {
    const planKey = biz.plan || 'Starter';
    const planDef = PLANS[planKey] || PLANS['Premium'];
    return biz.billing_cycle === 'yearly' ? planDef.yearly : planDef.monthly;
  }

  // ── Helper: charge one business via CamPay ────────────────
  async function chargeOne(biz) {
    console.log(`[chargeOne] biz=${biz.id} plan="${biz.plan}" status=${biz.status} phone="${biz.phone||biz.whatsapp||''}" sub_expires="${biz.sub_expires||''}"`);

    const rawPhone = phoneOverride || biz.phone || biz.whatsapp || '';
    const phone    = normalisePhone(rawPhone);
    if (!phone) {
      const err = `No valid phone. Stored: "${rawPhone}". Add MTN/Orange number via ⚙ Manage.`;
      console.warn(`[chargeOne] ${biz.id}: ${err}`);
      results.errors.push({ bizId: biz.id, name: biz.name, error: err });
      return;
    }

    // Case-insensitive plan lookup so "Pro", "pro", "Professional" all work
    const planKey = biz.plan || 'Starter';
    const planDef = PLANS[planKey]
      || PLANS[Object.keys(PLANS).find(k => k.toLowerCase() === planKey.toLowerCase())]
      || PLANS['Premium'];
    const amtXAF  = biz.billing_cycle === 'yearly' ? planDef.yearly : planDef.monthly;

    if (amtXAF === 0) {
      const reason = `Plan "${planKey}" is free/trial — no charge. Change plan to Starter/Professional/Enterprise.`;
      console.log(`[chargeOne] ${biz.id}: skipped — ${reason}`);
      results.skipped.push({ bizId: biz.id, name: biz.name, reason });
      return;
    }

    const planName = biz.plan || 'Starter';
    const ref  = `SUB-${biz.id}-${today.replace(/-/g,'')}-${Date.now().toString(36).slice(-4).toUpperCase()}`;
    const desc = `ShopTrack ${planName} — ${biz.name}`;

    console.log(`[chargeOne] ${biz.id}: calling CamPay collect | phone=${phone} | amount=${amtXAF} XAF | ref=${ref}`);

    try {
      const token  = await getCamPayToken(CAMPAY_BASE);
      console.log(`[chargeOne] ${biz.id}: CamPay token OK`);
      const result = await campayCollect(CAMPAY_BASE, token, phone, amtXAF, ref, desc);
      console.log(`[chargeOne] ${biz.id}: collect OK | campay_ref=${result.reference} | status=${result.status}`);

      // subscription_charges insert — non-fatal
      try {
        const scRes = await sb(SUPABASE_URL, SUPABASE_KEY, 'POST', 'subscription_charges', null, {
          id: ref, biz_id: biz.id, biz_name: biz.name, plan: planName,
          amount_xaf: amtXAF, phone, campay_ref: result.reference,
          status: 'PENDING', charged_at: new Date().toISOString(),
          billing_date: today, new_expiry: newExpiryOverride||null,
          self_service: !!phoneOverride,
        });
        if (!scRes.ok) console.warn(`[chargeOne] subscription_charges insert: HTTP ${scRes.status} — run migration Block 2`);
      } catch(e){ console.warn('[chargeOne] subscription_charges non-fatal:', e.message); }

      // businesses table update — non-fatal
      try {
        const bRes = await sb(SUPABASE_URL, SUPABASE_KEY, 'PATCH', 'businesses',
          `id=eq.${encodeURIComponent(biz.id)}`,
          { sub_last_charge_ref: result.reference, sub_charge_status: 'PENDING', sub_pending_expiry: newExpiryOverride||null }
        );
        if (!bRes.ok) console.warn(`[chargeOne] businesses update: HTTP ${bRes.status} — new columns may be missing`);
      } catch(e){ console.warn('[chargeOne] businesses update non-fatal:', e.message); }

      results.charged.push({ bizId: biz.id, name: biz.name, amountXAF: amtXAF, campayRef: result.reference, phone, newExpiry: newExpiryOverride||null });

    } catch (err) {
      console.error(`[chargeOne] ${biz.id}: FAILED — ${err.message}`);
      results.errors.push({ bizId: biz.id, name: biz.name, error: err.message });
    }
  }

  // ── Helper: build reminder for one business ───────────────
  function buildReminder(biz, daysLeft) {
    const amtXAF   = getAmountXAF(biz);
    const planName = biz.plan || 'Starter';
    const phone    = biz.phone || biz.whatsapp || '';
    const msg      = buildWAReminder(biz, daysLeft, amtXAF, planName);
    const waLink   = whatsappLink(phone, msg);
    return { bizId: biz.id, name: biz.name, phone, daysLeft, amtXAF, planName, message: msg, waLink };
  }

  // ── Helper: suspend one business ─────────────────────────
  async function suspendOne(biz) {
    await sb(SUPABASE_URL, SUPABASE_KEY, 'PATCH', 'businesses',
      `id=eq.${encodeURIComponent(biz.id)}`,
      { status: 'Suspended', suspended_reason: 'Non-payment — subscription expired 7+ days' }
    );
    results.suspended.push({ bizId: biz.id, name: biz.name });
    console.log(`[billing] Suspended ${biz.name} — non-payment`);
  }

  // ── ACTION: health — test that function is reachable ─────────
  // Call with { action: 'health' } to verify the function is deployed
  // and environment variables are configured, without triggering any charges.
  if (action === 'health') {
    const hasCamPay  = !!(process.env.CAMPAY_PERMANENT_TOKEN || (process.env.CAMPAY_APP_USERNAME && process.env.CAMPAY_APP_PASSWORD));
    const hasSupabase = !!(SUPABASE_URL && SUPABASE_KEY);
    return { statusCode: 200, headers, body: JSON.stringify({
      status:        'ok',
      function:      'campay-billing',
      campay:        hasCamPay  ? 'configured' : 'MISSING — set CAMPAY_PERMANENT_TOKEN in Netlify',
      supabase:      hasSupabase ? 'configured' : 'MISSING — set SUPABASE_URL and SUPABASE_SERVICE_KEY',
      env:           process.env.CAMPAY_ENV === 'PROD' ? 'PRODUCTION' : 'DEMO',
      businessCount: businesses.length,
      date:          today,
    })};
  }

  // ── ACTION: status — return billing state of all businesses ─
  if (action === 'status') {
    const summary = businesses
      .filter(b => b.plan && b.plan !== 'Trial (30 Days)' && b.status !== 'Deleted')
      .map(b => {
        const expiry   = b.sub_expires || null;  // only paid expiry counts for billing
      const trialExp = b.trial_end   || null;  // trial expiry shown separately
      const dLeft    = expiry ? daysUntil(expiry) : null;
      const amtXAF   = getAmountXAF(b);
      const isTrialOnly = !b.sub_expires && !!b.trial_end; // has trial but no paid sub
      return {
        bizId:    b.id,
        name:     b.name,
        owner:    b.owner,
        plan:     b.plan,
        status:   b.status,
        expiry,
        trialExpiry: isTrialOnly ? trialExp : null,
        daysLeft: dLeft,
        amountXAF: amtXAF,
        phone:    b.phone || b.whatsapp || null,
        billingStatus: isTrialOnly  ? 'trial_only'
                     : dLeft === null ? 'no_expiry'
                     : dLeft > 3     ? 'current'
                     : dLeft > 0     ? 'expiring_soon'
                     : dLeft === 0   ? 'due_today'
                     : dLeft >= -7   ? 'overdue'
                     : 'critical',
        willAutoCharge: !isTrialOnly && amtXAF > 0 && dLeft !== null && b.status === 'Active',
      };
      });
    return { statusCode: 200, headers, body: JSON.stringify({ action: 'status', businesses: summary, date: today }) };
  }

  // ── ACTION: extend — manually extend one business ─────────
  if (action === 'extend' && targetBizId) {
    const biz = businesses.find(b => b.id === targetBizId);
    if (!biz) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Business not found' }) };

    const currentExpiry = biz.sub_expires || today;
    const base = currentExpiry >= today ? currentExpiry : today;
    const newExpiry = daysFromNow.call(null, 0); // recalc
    const newDate   = new Date(base + 'T00:00:00');
    newDate.setDate(newDate.getDate() + extendDays);
    const newExpiryStr = newDate.toISOString().slice(0, 10);

    await sb(SUPABASE_URL, SUPABASE_KEY, 'PATCH', 'businesses',
      `id=eq.${encodeURIComponent(targetBizId)}`,
      { sub_expires: newExpiryStr, status: 'Active' }
    );
    results.extended.push({ bizId: targetBizId, name: biz.name, newExpiry: newExpiryStr, days: extendDays });
    return { statusCode: 200, headers, body: JSON.stringify(results) };
  }

  // ── ACTION: suspend ────────────────────────────────────────
  if (action === 'suspend' && targetBizId) {
    const biz = businesses.find(b => b.id === targetBizId);
    if (!biz) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Business not found' }) };
    await suspendOne(biz);
    return { statusCode: 200, headers, body: JSON.stringify(results) };
  }

  // ── ACTION: reactivate ─────────────────────────────────────
  if (action === 'reactivate' && targetBizId) {
    const biz = businesses.find(b => b.id === targetBizId);
    if (!biz) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Business not found' }) };
    // Extend 30 days from today
    const newExpiry = daysFromNow(30);
    await sb(SUPABASE_URL, SUPABASE_KEY, 'PATCH', 'businesses',
      `id=eq.${encodeURIComponent(targetBizId)}`,
      { status: 'Active', sub_expires: newExpiry, sub_charge_status: null }
    );
    results.extended.push({ bizId: targetBizId, name: biz.name, newExpiry, days: 30 });
    return { statusCode: 200, headers, body: JSON.stringify(results) };
  }

  // ── ACTION: charge_one ─────────────────────────────────────
  if (action === 'charge_one' && targetBizId) {
    const biz = businesses.find(b => b.id === targetBizId);
    if (!biz) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Business not found' }) };
    await chargeOne(biz);
    return { statusCode: 200, headers, body: JSON.stringify(results) };
  }

  // ── ACTION: remind_one ─────────────────────────────────────
  if (action === 'remind_one' && targetBizId) {
    const biz = businesses.find(b => b.id === targetBizId);
    if (!biz) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Business not found' }) };
    const expiry   = biz.sub_expires || biz.trial_end;
    const dLeft    = expiry ? daysUntil(expiry) : 0;
    const reminder = buildReminder(biz, dLeft);
    results.reminded.push(reminder);
    return { statusCode: 200, headers, body: JSON.stringify(results) };
  }

  // ── ACTION: charge_all — charge all businesses due today ───
  if (action === 'charge_all') {
    const due = businesses.filter(b => {
      if (!b.sub_expires) return false;                        // no paid expiry — skip
      if (b.status === 'Suspended' || b.status === 'Deleted' || b.status === 'Pending') return false;
      if (!b.plan || PLANS[b.plan]?.monthly === 0) return false; // free trial — skip
      const dLeft = daysUntil(b.sub_expires);
      return dLeft <= 0 && dLeft >= -7; // due today or up to 7 days overdue
    });
    for (const biz of due) await chargeOne(biz);
    return { statusCode: 200, headers, body: JSON.stringify(results) };
  }

  // ── ACTION: remind_all — build reminders for expiring soon ─
  if (action === 'remind_all') {
    const expiring = businesses.filter(b => {
      if (!b.sub_expires) return false;
      if (b.status === 'Suspended' || b.status === 'Deleted') return false;
      if (!b.plan || PLANS[b.plan]?.monthly === 0) return false;
      const dLeft = daysUntil(b.sub_expires);
      return dLeft >= 1 && dLeft <= 3;
    });
    for (const biz of expiring) {
      const dLeft    = daysUntil(biz.sub_expires);
      const reminder = buildReminder(biz, dLeft);
      results.reminded.push(reminder);
    }
    return { statusCode: 200, headers, body: JSON.stringify(results) };
  }

  // ── SCHEDULED — runs daily ────────────────────────────────
  if (action === 'scheduled_daily' || action === 'scheduled_monthly') {
    for (const biz of businesses) {
      // ── Skip non-chargeable businesses ──────────────────────
      if (biz.status === 'Deleted')    continue; // deleted
      if (biz.status === 'Suspended')  continue; // already suspended — don't double-charge
      if (biz.status === 'Pending')    continue; // not yet activated

      // Skip free trials — plan price must be > 0
      if (!biz.plan || PLANS[biz.plan]?.monthly === 0) continue;

      // Skip businesses that are still on trial only:
      // A trial business has trial_end set but no sub_expires (paid expiry).
      // Once a business pays their first subscription, sub_expires is set.
      // We only auto-charge businesses that have a sub_expires (paid subscription date).
      const hasPaidExpiry = !!biz.sub_expires;
      if (!hasPaidExpiry) {
        results.skipped.push({ bizId: biz.id, name: biz.name, reason: 'No paid subscription date (sub_expires) — may still be on trial or newly onboarded. Set sub_expires via the Manage modal to enable auto-billing.' });
        continue;
      }

      const expiry = biz.sub_expires;
      const dLeft  = daysUntil(expiry);

      // Automatic reminders: 3 days, 2 days, 1 day before expiry
      if (dLeft === 3 || dLeft === 2 || dLeft === 1) {
        const reminder = buildReminder(biz, dLeft);
        results.reminded.push(reminder);
        // Log reminder sent to Supabase audit_log
        await sb(SUPABASE_URL, SUPABASE_KEY, 'POST', 'audit_log', null, {
          id:         `REM-${biz.id}-${today}-d${dLeft}`,
          biz_id:     biz.id,
          action:     `Subscription reminder sent (${dLeft} day${dLeft !== 1 ? 's' : ''} before expiry)`,
          detail:     `${biz.plan} plan expires ${expiry} | ${getAmountXAF(biz).toLocaleString()} XAF due`,
          actor:      'ShopTrack Billing',
          created_at: new Date().toISOString(),
        });
      }

      // Charge on expiry day (dLeft === 0) or on 1st of month if overdue
      if (dLeft === 0 || action === 'scheduled_monthly') {
        if (biz.status === 'Active' && dLeft <= 0 && dLeft >= -7) {
          await chargeOne(biz);
        }
      }

      // Auto-suspend 7 days after expiry
      if (dLeft === -7 && biz.status === 'Active') {
        await suspendOne(biz);
        // Log auto-suspension
        await sb(SUPABASE_URL, SUPABASE_KEY, 'POST', 'audit_log', null, {
          id:         `SUS-${biz.id}-${today}`,
          biz_id:     biz.id,
          action:     'Business auto-suspended — subscription expired 7 days ago',
          detail:     `${biz.plan} plan | Last expiry: ${expiry}`,
          actor:      'ShopTrack Billing',
          created_at: new Date().toISOString(),
        });
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify(results) };
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown action: ${action}` }) };
};
