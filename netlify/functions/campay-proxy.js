// netlify/functions/campay-proxy.js
// Secure server-side proxy for CamPay Mobile Money (Cameroon).
// API keys NEVER reach the browser — they live only in Netlify env vars.
//
// ── Required env vars (Netlify → Site configuration → Environment variables) ──
//
//   CAMPAY_APP_USERNAME     → "App Username" from CamPay dashboard (API ACCESS KEYS section)
//   CAMPAY_APP_PASSWORD     → "App Password" from CamPay dashboard (API ACCESS KEYS section)
//
//   OR (simpler — use this instead of username/password):
//   CAMPAY_PERMANENT_TOKEN  → "Permanent Access Token" from CamPay dashboard
//                             This never expires — copy and paste it directly.
//
//   CAMPAY_APP_NAME         → Your registered application name (e.g. "ShopTrack")
//   CAMPAY_ENV              → "PROD" for live money. Leave blank or "DEMO" for sandbox.
//
// ── How the dashboard maps to env vars ───────────────────────
//   CamPay Dashboard Label        →  Netlify Env Var
//   ─────────────────────────────────────────────────────────
//   App Username                  →  CAMPAY_APP_USERNAME
//   App Password                  →  CAMPAY_APP_PASSWORD
//   Permanent Access Token        →  CAMPAY_PERMANENT_TOKEN  (preferred — use this)
//   App Webhook Key               →  Not used here (used in campay-webhook.js)
//
// ── API base URLs ──────────────────────────────────────────────
//   Demo:       https://demo.campay.net/api
//   Production: https://campay.net/api
//
// ── Supported actions (POST body: { action, bizId, ...params }) ──
//   "collect"  — Push payment request to customer's MTN or Orange number
//   "disburse" — Send money out (payouts to suppliers / staff)
//   "status"   — Check transaction status by CamPay reference
//   "balance"  — Get current CamPay wallet balance
//
// ── CamPay rules ──────────────────────────────────────────────
//   - Amounts must be INTEGERS (whole XAF only — no decimals)
//   - Phone numbers: 237XXXXXXXXX (9 local digits prefixed with 237)
//   - Supported networks: MTN Cameroon and Orange Cameroon only

'use strict';

// ── In-memory token cache (only used when relying on username/password auth) ─
let _tokenCache = { token: null, expiresAt: 0 };

// ── Rate limiting ─────────────────────────────────────────────
const _ipLog     = {};
const RATE_WINDOW = 60_000;
const RATE_MAX    = 20;
function isRateLimited(ip) {
  const now = Date.now();
  if (!_ipLog[ip]) _ipLog[ip] = [];
  _ipLog[ip] = _ipLog[ip].filter(t => now - t < RATE_WINDOW);
  if (_ipLog[ip].length >= RATE_MAX) return true;
  _ipLog[ip].push(now);
  return false;
}

// ── Phone normalisation ───────────────────────────────────────
// Accepts: 237XXXXXXXXX | 6XXXXXXXX | 06XXXXXXXX
// Returns: 237XXXXXXXXX
function normalisePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('237') && digits.length === 12) return digits;
  if (digits.length === 9) return '237' + digits;
  if (digits.length === 10 && digits.startsWith('0')) return '237' + digits.slice(1);
  return null;
}

// ── Carrier detection from phone prefix ──────────────────────
function detectCarrier(n) {
  if (!n) return 'unknown';
  const p3 = parseInt(n.slice(3, 6), 10); // first 3 digits after 237
  if ((p3 >= 670 && p3 <= 679) || (p3 >= 650 && p3 <= 654) || (p3 >= 680 && p3 <= 689)) return 'MTN';
  if ((p3 >= 655 && p3 <= 657) || (p3 >= 695 && p3 <= 699) || (p3 >= 620 && p3 <= 629)) return 'Orange';
  return 'unknown';
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type':                 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // ── Rate limit ───────────────────────────────────────────
  const clientIp = event.headers['x-forwarded-for']?.split(',')[0].trim()
                || event.headers['client-ip'] || 'unknown';
  if (isRateLimited(clientIp)) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many requests. Please wait and try again.' }) };
  }

  // ── Parse body ────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) }; }

  const { action, bizId } = body;
  if (!bizId || typeof bizId !== 'string' || bizId.length > 64) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing or invalid bizId' }) };
  }
  if (!action) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing action' }) };
  }

  // ── Load credentials ─────────────────────────────────────
  // Preferred: Permanent Access Token (never expires, copy directly from CamPay dashboard)
  // Fallback:  App Username + App Password (token refreshed every ~60 minutes)
  const PERMANENT_TOKEN = process.env.CAMPAY_PERMANENT_TOKEN;
  const USERNAME        = process.env.CAMPAY_APP_USERNAME;
  const PASSWORD        = process.env.CAMPAY_APP_PASSWORD;
  const APP_NAME        = process.env.CAMPAY_APP_NAME   || 'ShopTrack';
  const IS_PROD         = process.env.CAMPAY_ENV        === 'PROD';
  const BASE_URL        = IS_PROD
    ? 'https://campay.net/api'
    : 'https://demo.campay.net/api';

  if (!PERMANENT_TOKEN && (!USERNAME || !PASSWORD)) {
    console.error('[campay-proxy] No credentials: set CAMPAY_PERMANENT_TOKEN or CAMPAY_APP_USERNAME + CAMPAY_APP_PASSWORD');
    return {
      statusCode: 503, headers,
      body: JSON.stringify({ error: 'Mobile money service not configured. Contact support@shoptrack.work.' }),
    };
  }

  // ── Get auth token ────────────────────────────────────────
  // If CAMPAY_PERMANENT_TOKEN is set, use it directly — no /token/ call needed.
  // Otherwise fetch a temporary token using username/password.
  async function getToken() {
    if (PERMANENT_TOKEN) return PERMANENT_TOKEN;

    const now = Date.now();
    if (_tokenCache.token && _tokenCache.expiresAt > now + 120_000) return _tokenCache.token;

    const res = await fetch(`${BASE_URL}/token/`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`CamPay auth error (${res.status}): ${err}`);
    }
    const data = await res.json();
    _tokenCache = { token: data.token, expiresAt: now + (data.expires_in || 3600) * 1000 };
    return data.token;
  }

  // ── CamPay API call helper ────────────────────────────────
  async function campayCall(method, endpoint, payload) {
    const token = await getToken();
    const res   = await fetch(`${BASE_URL}${endpoint}`, {
      method,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Token ${token}`,
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(data?.detail || data?.message || `CamPay error (${res.status}): ${text}`);
    return data;
  }

  // ── Dispatch ──────────────────────────────────────────────
  try {

    // ── collect ──────────────────────────────────────────────
    if (action === 'collect') {
      const { phone, amount, reference, description } = body;

      const normPhone = normalisePhone(phone);
      if (!normPhone) {
        return { statusCode: 400, headers,
          body: JSON.stringify({ error: 'Invalid phone number. Use a valid Cameroonian MTN or Orange number (e.g. 671234567).', code: 'ER101' }) };
      }
      const carrier = detectCarrier(normPhone);
      if (carrier === 'unknown') {
        return { statusCode: 400, headers,
          body: JSON.stringify({ error: 'Phone number not recognised as MTN or Orange. Only these two networks are supported.', code: 'ER102' }) };
      }
      const amtInt = Math.round(Number(amount));
      if (!amtInt || amtInt < 100) {
        return { statusCode: 400, headers,
          body: JSON.stringify({ error: 'Amount must be at least 100 XAF.', code: 'ER201' }) };
      }
      if (!reference) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'reference is required' }) };
      }

      console.log(`[campay-proxy] collect | biz=${bizId} | ref=${reference} | phone=${normPhone} | amount=${amtInt} XAF | network=${carrier}`);

      const result = await campayCall('POST', '/collect/', {
        amount:             amtInt,
        from:               normPhone,
        description:        description || `Payment to ${APP_NAME}`,
        external_reference: String(reference).slice(0, 50),
      });

      return { statusCode: 200, headers, body: JSON.stringify({
        success:    true,
        reference:  result.reference,
        status:     result.status,
        operator:   carrier,
        ussd_code:  result.ussd_code || null,
        amount_xaf: amtInt,
        phone:      normPhone,
      })};
    }

    // ── status ────────────────────────────────────────────────
    if (action === 'status') {
      const { reference } = body;
      if (!reference) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'reference is required' }) };
      }
      console.log(`[campay-proxy] status | biz=${bizId} | ref=${reference}`);
      const result = await campayCall('GET', `/transaction/${encodeURIComponent(reference)}/`);
      return { statusCode: 200, headers, body: JSON.stringify({
        reference: result.reference,
        status:    result.status,
        amount:    result.amount,
        operator:  result.operator,
        reason:    result.reason || null,
        ts:        result.timestamp || null,
      })};
    }

    // ── disburse ──────────────────────────────────────────────
    if (action === 'disburse') {
      const { phone, amount, reference, description } = body;
      const normPhone = normalisePhone(phone);
      if (!normPhone) {
        return { statusCode: 400, headers,
          body: JSON.stringify({ error: 'Invalid phone number', code: 'ER101' }) };
      }
      const amtInt = Math.round(Number(amount));
      if (!amtInt || amtInt < 100) {
        return { statusCode: 400, headers,
          body: JSON.stringify({ error: 'Amount must be at least 100 XAF', code: 'ER201' }) };
      }
      console.log(`[campay-proxy] disburse | biz=${bizId} | ref=${reference} | phone=${normPhone} | amount=${amtInt} XAF`);
      const result = await campayCall('POST', '/disburse/', {
        amount:             amtInt,
        to:                 normPhone,
        description:        description || `Payout from ${APP_NAME}`,
        external_reference: String(reference || '').slice(0, 50),
      });
      return { statusCode: 200, headers, body: JSON.stringify({
        success:   true,
        reference: result.reference,
        status:    result.status,
        operator:  result.operator || detectCarrier(normPhone),
      })};
    }

    // ── balance ────────────────────────────────────────────────
    if (action === 'balance') {
      console.log(`[campay-proxy] balance | biz=${bizId}`);
      const result = await campayCall('GET', '/get_balance/');
      return { statusCode: 200, headers, body: JSON.stringify({ balance: result }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown action: ${action}` }) };

  } catch (err) {
    console.error(`[campay-proxy] Error | action=${action} | biz=${bizId} |`, err.message);
    const msg = err.message || '';
    let userMsg = 'Mobile money request failed. Please try again.';
    if (msg.includes('ER101') || msg.toLowerCase().includes('invalid phone'))
      userMsg = 'Invalid phone number. Please check and try again.';
    else if (msg.includes('ER102') || msg.toLowerCase().includes('unsupported'))
      userMsg = 'Only MTN and Orange numbers are supported in Cameroon.';
    else if (msg.includes('ER201') || msg.toLowerCase().includes('invalid amount'))
      userMsg = 'Invalid amount. Must be a whole number with no decimals.';
    else if (msg.includes('ER301') || msg.toLowerCase().includes('insufficient'))
      userMsg = 'Insufficient CamPay wallet balance for this payout.';
    else if (msg.toLowerCase().includes('auth') || msg.includes('401') || msg.includes('403'))
      userMsg = 'CamPay authentication failed. Check CAMPAY credentials in Netlify env vars.';
    else if (msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('network'))
      userMsg = 'Could not reach the mobile money network. Please try again in a moment.';
    return { statusCode: 502, headers, body: JSON.stringify({ error: userMsg, detail: msg }) };
  }
};
