// netlify/functions/dalle-proxy.js
// Secure server-side proxy for OpenAI DALL-E image generation.
// The OpenAI key NEVER reaches the browser.
//
// Required env var in Netlify → Site configuration → Environment variables:
//   OPENAI_API_KEY  →  sk-…  (from platform.openai.com/api-keys)
//
// Cost: ~$0.04 per image (DALL-E 3 standard 1024x1024)
// Rate limit: 5 images per IP per hour (abuse prevention)

const _ipLog = {};
function isRateLimited(ip) {
  const now = Date.now();
  const window = 3_600_000; // 1 hour
  const max    = 5;         // 5 images per hour per IP
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

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) {
    return {
      statusCode: 503,
      headers,
      body: JSON.stringify({ error: 'AI image generation is not configured. Add your OpenAI key in Settings → AI Studio to use this feature.' }),
    };
  }

  // IP rate limit — 5 images/hour is generous for normal use
  const clientIp = event.headers['x-forwarded-for']?.split(',')[0].trim() || 'unknown';
  if (isRateLimited(clientIp)) {
    return {
      statusCode: 429,
      headers,
      body: JSON.stringify({ error: 'Image generation limit reached (5 images/hour). Please wait before generating more.' }),
    };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) }; }

  const { body: dalleBody, bizId } = body;
  if (!dalleBody?.prompt || !bizId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing prompt or bizId' }) };
  }

  // Enforce safe defaults — don't let client request expensive options
  const safeBody = {
    model:           'dall-e-3',
    prompt:          dalleBody.prompt.substring(0, 1000), // cap prompt length
    n:               1,                                   // always 1
    size:            '1024x1024',                         // standard size
    quality:         'standard',                          // not 'hd' ($0.08)
    response_format: 'url',
  };

  let res;
  try {
    res = await fetch('https://api.openai.com/v1/images/generations', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body:    JSON.stringify(safeBody),
    });
  } catch (err) {
    console.error('[dalle-proxy] Network error:', err.message);
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not reach image generation service. Please try again.' }) };
  }

  if (!res.ok) {
    let errMsg = `Image API error (${res.status})`;
    try { const e = await res.json(); errMsg = e?.error?.message || errMsg; } catch {}
    console.error('[dalle-proxy] OpenAI error:', errMsg);
    return { statusCode: res.status >= 500 ? 502 : res.status, headers, body: JSON.stringify({ error: errMsg }) };
  }

  const result = await res.json();
  return { statusCode: 200, headers, body: JSON.stringify(result) };
};
