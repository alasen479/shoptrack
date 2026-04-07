// netlify/functions/ai-proxy.js
// Secure server-side proxy for Anthropic AI calls.
// The API key NEVER reaches the browser — it lives only in Netlify env vars.
//
// Required env var in Netlify → Site configuration → Environment variables:
//   ANTHROPIC_API_KEY  →  sk-ant-api03-…  (from console.anthropic.com/keys)
//
// All businesses on the platform share this key with no usage limits.
// Businesses that enter their own key in Settings bypass this proxy entirely.

// Cap tokens per request so no single call can run up an outsized bill.
const MAX_TOKENS = 1500;

// Basic rate-limit: max 30 requests per IP per minute (abuse prevention only)
const _ipLog = {};
function isRateLimited(ip) {
  const now = Date.now();
  const window = 60_000;
  const max    = 30;
  if (!_ipLog[ip]) _ipLog[ip] = [];
  _ipLog[ip] = _ipLog[ip].filter(t => now - t < window);
  if (_ipLog[ip].length >= max) return true;
  _ipLog[ip].push(now);
  return false;
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type':                 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // ── API key check ─────────────────────────────────────────────
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    console.error('[ai-proxy] ANTHROPIC_API_KEY env var is not set');
    return {
      statusCode: 503,
      headers,
      body: JSON.stringify({ error: 'AI service not configured. Please contact support.' }),
    };
  }

  // ── IP rate limit (abuse guard) ───────────────────────────────
  const clientIp = event.headers['x-forwarded-for']?.split(',')[0].trim()
                || event.headers['client-ip']
                || 'unknown';
  if (isRateLimited(clientIp)) {
    return {
      statusCode: 429,
      headers,
      body: JSON.stringify({ error: 'Too many requests. Please wait a moment and try again.' }),
    };
  }

  // ── Parse body ────────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { payload, bizId } = body;

  if (!payload || !payload.messages || !Array.isArray(payload.messages)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing or invalid payload.messages' }) };
  }
  if (!bizId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing bizId' }) };
  }

  // ── Sanitise payload ──────────────────────────────────────────
  // Validate bizId format — must be a non-empty string under 64 chars
  if (typeof bizId !== 'string' || bizId.trim().length === 0 || bizId.length > 64) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid bizId' }) };
  }

  const safePayload = {
    model:      payload.model || 'claude-haiku-4-5-20251001', // Haiku 4.5 — fast & cost-efficient
    max_tokens: Math.min(payload.max_tokens || 900, MAX_TOKENS),
    messages:   payload.messages,
    ...(payload.system ? { system: payload.system } : {}),
  };

  // ── Call Anthropic ────────────────────────────────────────────
  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(safePayload),
    });
  } catch (networkErr) {
    console.error('[ai-proxy] Network error:', networkErr.message);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'Could not reach AI service. Please try again.' }),
    };
  }

  if (!anthropicRes.ok) {
    let errMsg = `AI API error (${anthropicRes.status})`;
    try {
      const errBody = await anthropicRes.json();
      errMsg = errBody?.error?.message || errMsg;
    } catch {}
    console.error('[ai-proxy] Anthropic error:', errMsg);
    return {
      statusCode: anthropicRes.status >= 500 ? 502 : anthropicRes.status,
      headers,
      body: JSON.stringify({ error: errMsg }),
    };
  }

  const result = await anthropicRes.json();
  return { statusCode: 200, headers, body: JSON.stringify(result) };
};
