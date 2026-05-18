// netlify/functions/aff-request-link.js
// Send a magic sign-in link to an affiliate's registered email.
//
// Security model:
//   - Token = HMAC-SHA256(email|expiry, AFFILIATE_AUTH_SECRET) — stateless, no DB
//   - Expires after 30 minutes
//   - Verification happens in aff-lookup.js against the same secret
//   - To prevent enumeration ("does this email exist?"), we always return
//     success even when the email is not on file. The email simply isn't sent.
//
// Env vars required:
//   BREVO_API_KEY           → for the email send
//   AFFILIATE_AUTH_SECRET   → secret used for HMAC signing (any random 32+ char string)
//   SUPABASE_URL, SUPABASE_SERVICE_KEY → for looking up the affiliate record
//
// Body: { email: "user@example.com" }
// Response: { success: true }   (uniform — email may or may not have been sent)

const crypto = require('crypto');

function signToken(email, expiresAt, secret){
  // payload = base64url(email|expiresAt)
  // signature = HMAC-SHA256(payload, secret) → first 32 chars hex
  // token = payload + '.' + signature
  const payload = Buffer.from(`${email.toLowerCase()}|${expiresAt}`).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32);
  return `${payload}.${sig}`;
}

function buildHtml(firstName, dashboardUrl) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#ffffff;font-family:'Segoe UI',Arial,sans-serif;color:#1e293b">
  <div style="max-width:520px;margin:32px auto;padding:0 16px">
    <div style="margin-bottom:28px;padding-bottom:16px;border-bottom:1px solid #e2e8f0">
      <span style="font-size:18px;font-weight:800;color:#4f46e5;letter-spacing:-.3px">ShopTrack</span>
    </div>

    <p style="font-size:15px;font-weight:600;color:#0f172a;margin:0 0 16px">Hi ${firstName},</p>

    <p style="font-size:14px;color:#334155;line-height:1.7;margin:0 0 14px">
      Click the button below to access your affiliate dashboard. This link is valid for 30 minutes and works on any device.
    </p>

    <div style="margin:24px 0">
      <a href="${dashboardUrl}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;font-size:14px">
        Open My Dashboard →
      </a>
    </div>

    <p style="font-size:13px;color:#475569;line-height:1.7;margin:0 0 14px">
      Or copy this link into your browser:<br>
      <span style="font-family:'Courier New',monospace;font-size:12px;color:#4f46e5;word-break:break-all">${dashboardUrl}</span>
    </p>

    <div style="margin-top:28px;padding-top:14px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;line-height:1.6">
      <p style="margin:0 0 6px"><strong>Didn't request this?</strong></p>
      <p style="margin:0">Someone may have typed your email by accident. You can safely ignore this message — no one can access your dashboard without clicking the link above.</p>
    </div>

    <p style="font-size:11px;color:#94a3b8;margin-top:24px">
      Sent by ShopTrack · <a href="mailto:support@shoptrack.work" style="color:#4f46e5">support@shoptrack.work</a>
    </p>
  </div>
</body>
</html>`;
}

function buildText(firstName, dashboardUrl) {
  return `Hi ${firstName},

Click this link to access your ShopTrack affiliate dashboard:

${dashboardUrl}

This link is valid for 30 minutes and works on any device.

Didn't request this? Someone may have typed your email by accident. You can safely ignore this message — no one can access your dashboard without clicking the link.

— ShopTrack
support@shoptrack.work`;
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const rawEmail = (body.email || '').toString().trim();
  if (!rawEmail || !rawEmail.includes('@')) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid email required' }) };
  }
  const email = rawEmail.toLowerCase();

  const SECRET   = process.env.AFFILIATE_AUTH_SECRET || '';
  const BREVO    = process.env.BREVO_API_KEY || '';
  const SB_URL   = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const SB_KEY   = process.env.SUPABASE_SERVICE_KEY || '';

  if (!SECRET || SECRET.length < 32) {
    console.error('[aff-request-link] AFFILIATE_AUTH_SECRET missing or too short (need 32+ chars)');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Auth not configured' }) };
  }
  if (!BREVO) {
    console.error('[aff-request-link] BREVO_API_KEY not set');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Email service not configured' }) };
  }

  // ── Look up the affiliate. Only send the link if the email is actually
  //    registered. But ALWAYS return success to the client to prevent
  //    email enumeration attacks.
  let affName = '';
  let affFound = false;
  if (SB_URL && SB_KEY) {
    try {
      const res = await fetch(
        `${SB_URL}/rest/v1/affiliates?email=eq.${encodeURIComponent(email)}&select=name&limit=1`,
        { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } }
      );
      const rows = await res.json().catch(() => []);
      if (Array.isArray(rows) && rows.length) {
        affFound = true;
        affName = rows[0].name || '';
      }
    } catch (e) {
      console.warn('[aff-request-link] lookup failed:', e.message);
      // Continue — we still return success for enumeration safety.
    }
  }

  if (!affFound) {
    console.log('[aff-request-link] Unknown email (silent):', email);
    // Uniform response — no signal whether the email exists.
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  // ── Generate signed token, valid for 30 minutes ─────────────────────────
  const expiresAt = Date.now() + 30 * 60 * 1000; // 30 min in ms
  const token = signToken(email, expiresAt, SECRET);

  // The dashboard URL the affiliate will click
  const dashboardUrl = `https://shoptrack.org/affiliates.html?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}#dashboard`;

  const firstName = (affName || 'there').split(' ')[0];

  // ── Send the email via Brevo (same pattern as aff-approve-email.js) ─────
  try {
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': BREVO },
      body: JSON.stringify({
        sender:      { name: 'ShopTrack', email: 'support@shoptrack.work' },
        to:          [{ email, name: affName || firstName }],
        replyTo:     { email: 'support@shoptrack.work' },
        subject:     'Your ShopTrack affiliate sign-in link',
        htmlContent: buildHtml(firstName, dashboardUrl),
        textContent: buildText(firstName, dashboardUrl),
        tags:        ['affiliate-signin'],
        headers:     { 'X-Mailin-custom': 'transactional' },
      })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error('[aff-request-link] Brevo error:', resp.status, JSON.stringify(data));
      // Still return success — don't tell client whether send worked
      // (avoids partial enumeration via response timing).
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }
    console.log('[aff-request-link] Sent to', email, '| messageId:', data.messageId);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  } catch (e) {
    console.error('[aff-request-link] send failed:', e.message);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }
};
