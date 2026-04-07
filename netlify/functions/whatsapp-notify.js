// netlify/functions/whatsapp-notify.js
// Sends WhatsApp messages via Twilio API (registered WhatsApp sender).
//
// Supports two modes:
//   1. Template messages (required for business-initiated outbound)
//   2. Freeform messages (only within 24hr of customer replying)
//
// Required Netlify env vars:
//   TWILIO_ACCOUNT_SID  — from twilio.com/console
//   TWILIO_AUTH_TOKEN   — from twilio.com/console
//   TWILIO_WA_NUMBER    — registered WhatsApp sender e.g. +13045033113

const TWILIO_API = 'https://api.twilio.com/2010-04-01/Accounts';

// ── Approved template SIDs ────────────────────────────────────
const TEMPLATES = {
  // New sale alert to owner
  // Vars: 1=bizName 2=saleId 3=custName 4=items 5=total 6=paidLine 7=staff 8=method 9=date
  new_sale_alert: 'HXe8714706a1f6c0d3553c01158ebfcff8',  // copy_new_sale_alert2 — Under Review (Apr 3 2026)
};

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // ── GET: diagnostic ──────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const sid   = process.env.TWILIO_ACCOUNT_SID || '';
    const token = process.env.TWILIO_AUTH_TOKEN  || '';
    const waNum = process.env.TWILIO_WA_NUMBER   || '';
    return { statusCode: 200, headers, body: JSON.stringify({
      status:            'whatsapp-notify v6 (template+freeform) running',
      TWILIO_SID_set:    sid.length > 0,
      TWILIO_SID_prefix: sid.slice(0, 8) || 'NOT SET',
      TWILIO_TOKEN_set:  token.length > 0,
      TWILIO_WA_NUMBER:  waNum || 'NOT SET',
      templates:         Object.keys(TEMPLATES),
    })};
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
  const AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || '';
  const FROM_RAW    = process.env.TWILIO_WA_NUMBER   || '';
  const FROM_NUMBER = FROM_RAW.replace(/[^0-9+]/g, '');

  if (!ACCOUNT_SID || !AUTH_TOKEN || !FROM_NUMBER) {
    const missing = [
      !ACCOUNT_SID  && 'TWILIO_ACCOUNT_SID',
      !AUTH_TOKEN   && 'TWILIO_AUTH_TOKEN',
      !FROM_NUMBER  && 'TWILIO_WA_NUMBER',
    ].filter(Boolean).join(', ');
    return { statusCode: 200, headers,
      body: JSON.stringify({ success: false, error: 'Missing env vars: ' + missing }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { to, message, template, variables } = body;
  if (!to || (!message && !template)) {
    return { statusCode: 400, headers,
      body: JSON.stringify({ error: 'to and either message or template are required' }) };
  }

  // Normalise phone to E.164
  const digits = String(to).replace(/\D/g, '');
  let normalised;
  if      (digits.length === 9  && (digits.startsWith('6') || digits.startsWith('2'))) normalised = '+237' + digits;
  else if (digits.startsWith('237') && digits.length === 12) normalised = '+' + digits;
  else if (digits.startsWith('234') && digits.length >= 13)  normalised = '+' + digits;
  else if (digits.length === 10 && !digits.startsWith('0'))  normalised = '+1'  + digits;
  else if (digits.startsWith('1')  && digits.length === 11)  normalised = '+' + digits;
  else if (digits.length >= 10) normalised = '+' + digits;
  else return { statusCode: 400, headers,
    body: JSON.stringify({ error: 'Invalid phone number: ' + to }) };

  const fromE164 = FROM_NUMBER.startsWith('+') ? FROM_NUMBER : '+' + FROM_NUMBER;
  const fromWA   = 'whatsapp:' + fromE164;
  const toWA     = 'whatsapp:' + normalised;

  console.log('[WA] From:', fromWA, '-> To:', toWA);

  // Build Twilio params
  const params = new URLSearchParams({ From: fromWA, To: toWA });

  if (template && TEMPLATES[template]) {
    const sid = TEMPLATES[template];
    params.set('ContentSid', sid);
    if (variables && typeof variables === 'object') {
      params.set('ContentVariables', JSON.stringify(variables));
    }
    console.log('[WA] Using template:', template, sid);
  } else {
    params.set('Body', message);
    console.log('[WA] Freeform message:', (message||'').slice(0, 100));
  }

  const url  = TWILIO_API + '/' + ACCOUNT_SID + '/Messages.json';
  const auth = Buffer.from(ACCOUNT_SID + ':' + AUTH_TOKEN).toString('base64');

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString(),
    });

    let data = {};
    try { data = await res.json(); } catch(e2) {}
    console.log('[WA] Twilio status:', res.status, JSON.stringify(data).slice(0, 400));

    if (!res.ok || data.error_code) {
      const code = data.error_code || res.status;
      let hint   = data.message || data.error_message || 'HTTP ' + res.status;
      if (code === 63007) hint = 'WhatsApp channel not found for sender. Check TWILIO_WA_NUMBER.';
      if (code === 63016) hint = 'Freeform outside 24hr window — use a template instead.';
      if (code === 63038) hint = 'Template not approved yet. Wait for Meta approval.';
      if (code === 20003) hint = 'Auth failed — check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.';
      if (code === 21211) hint = 'Invalid phone number: ' + normalised;
      console.error('[WA] FAILED:', code, hint);
      return { statusCode: 200, headers,
        body: JSON.stringify({ success: false, error: hint, code: code, raw: data }) };
    }

    console.log('[WA] SUCCESS - SID:', data.sid, '| Status:', data.status);
    return { statusCode: 200, headers,
      body: JSON.stringify({ success: true, messageId: data.sid, to: normalised, status: data.status }) };

  } catch(err) {
    console.error('[WA] Network error:', err.message);
    return { statusCode: 200, headers,
      body: JSON.stringify({ success: false, error: 'Network error: ' + err.message }) };
  }
};
