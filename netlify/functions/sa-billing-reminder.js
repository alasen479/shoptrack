// netlify/functions/sa-billing-reminder.js
// Sends a polished billing-reminder email from the Super Admin to a business
// owner via Brevo. Used when a business is approaching expiry / overdue.
//
// Security model:
//   The endpoint is gated by a shared secret env var SA_FN_SECRET. The
//   frontend includes it in the request body. This stops an external
//   caller from spamming arbitrary email addresses, while keeping the
//   integration zero-friction for the actual SA panel.
//
// Env vars required:
//   BREVO_API_KEY   →  Brevo transactional key (already configured for
//                     affiliate emails — same key works here)
//   SA_FN_SECRET    →  Any random 32+ char string. Set in Netlify, same
//                     all-scopes pattern as AFFILIATE_AUTH_SECRET.
//
// Body: {
//   secret:      "<SA_FN_SECRET>"  (required)
//   to_email:    "owner@example.com"  (required)
//   to_name:     "Moise Ndi"  (optional, used for personalisation)
//   biz_name:    "INDUSTRIOUS LTD"  (optional)
//   subject:     "..."  (required)
//   body_text:   "Plain-text message body"  (required — what the SA typed)
// }
// Response: { success: true, messageId } | { success: false, error }

function buildHtml(toName, bizName, bodyText) {
  // Convert the plain-text body the SA edited into safe HTML:
  //   - escape any < > &
  //   - preserve line breaks (\n → <br>)
  //   - preserve double line breaks as paragraph spacing (already handled by <br>)
  const safe = String(bodyText || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, '<br>');

  const greetingName = (toName || 'there').split(' ')[0];

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

    <p style="font-size:15px;font-weight:600;color:#0f172a;margin:0 0 16px">Hi ${greetingName},</p>

    <div style="font-size:14px;color:#334155;line-height:1.7;margin:0 0 20px">
      ${safe}
    </div>

    <div style="margin-top:32px;padding-top:18px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;line-height:1.7">
      <div>Log in to renew or update payment: <a href="https://shoptrack.org" style="color:#4f46e5">shoptrack.org</a></div>
      <div style="margin-top:6px">Questions? Reply to this email — we read every message.</div>
    </div>

    <p style="font-size:11px;color:#94a3b8;margin-top:24px">
      Sent by ShopTrack &middot; <a href="mailto:support@shoptrack.work" style="color:#4f46e5">support@shoptrack.work</a>
    </p>
  </div>
</body>
</html>`;
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Invalid JSON' }) }; }

  const SECRET = process.env.SA_FN_SECRET || '';
  if (!SECRET || SECRET.length < 16) {
    console.error('[sa-billing-reminder] SA_FN_SECRET missing or too short. Set it in Netlify env.');
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'Function not configured' }) };
  }
  if ((body.secret || '') !== SECRET) {
    console.warn('[sa-billing-reminder] Rejected: bad secret');
    return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: 'Unauthorized' }) };
  }

  const toEmail = (body.to_email || '').toString().trim();
  const toName  = (body.to_name  || '').toString().trim();
  const bizName = (body.biz_name || '').toString().trim();
  const subject = (body.subject  || '').toString().trim();
  const bodyTxt = (body.body_text || '').toString();

  if (!toEmail || !toEmail.includes('@')) {
    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Valid recipient email required' }) };
  }
  if (!subject) {
    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Subject required' }) };
  }
  if (!bodyTxt.trim()) {
    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Body required' }) };
  }

  const BREVO = process.env.BREVO_API_KEY || '';
  if (!BREVO) {
    console.error('[sa-billing-reminder] BREVO_API_KEY not set');
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'Email service not configured' }) };
  }

  try {
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': BREVO },
      body: JSON.stringify({
        sender:      { name: 'ShopTrack', email: 'support@shoptrack.work' },
        to:          [{ email: toEmail, name: toName || bizName || toEmail }],
        replyTo:     { email: 'support@shoptrack.work', name: 'ShopTrack Support' },
        subject:     subject,
        htmlContent: buildHtml(toName, bizName, bodyTxt),
        textContent: bodyTxt,
        tags:        ['sa-billing-reminder'],
        headers:     { 'X-Mailin-custom': 'transactional' },
      })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error('[sa-billing-reminder] Brevo error:', resp.status, JSON.stringify(data));
      return { statusCode: 502, headers, body: JSON.stringify({ success: false, error: (data && (data.message || data.code)) || 'Email send failed' }) };
    }
    console.log('[sa-billing-reminder] Sent to', toEmail, '| messageId:', data.messageId);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, messageId: data.messageId }) };
  } catch (e) {
    console.error('[sa-billing-reminder] send failed:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: e.message || 'Network error' }) };
  }
};
