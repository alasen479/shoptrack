// netlify/functions/aff-approve-email.js
// Sends affiliate approval email with referral link via Brevo.
// Written as a plain transactional email (not marketing) to land in Primary inbox.
//
// Env vars required:
//   BREVO_API_KEY  →  xkeysib-xxxxxxxxxxxx  (from brevo.com)
//
// Body: { name, email, affiliate_code, social_handle }

function buildHtml(firstName, affiliateCode, affiliateLink) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#ffffff;font-family:'Segoe UI',Arial,sans-serif;color:#1e293b">
  <div style="max-width:520px;margin:32px auto;padding:0 16px">

    <!-- Minimal header -->
    <div style="margin-bottom:28px;padding-bottom:16px;border-bottom:1px solid #e2e8f0">
      <span style="font-size:18px;font-weight:800;color:#4f46e5;letter-spacing:-.3px">ShopTrack</span>
    </div>

    <!-- Body — plain and personal -->
    <p style="font-size:15px;font-weight:600;color:#0f172a;margin:0 0 16px">Hi ${firstName},</p>

    <p style="font-size:14px;color:#334155;line-height:1.7;margin:0 0 14px">
      Your ShopTrack affiliate application has been reviewed and approved. You can start referring businesses right away.
    </p>

    <!-- Link block — simple, not decorative -->
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-left:4px solid #4f46e5;border-radius:0 8px 8px 0;padding:16px 20px;margin:20px 0">
      <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px">Your referral link</div>
      <div style="font-size:14px;font-weight:600;color:#4f46e5;word-break:break-all;margin-bottom:10px">${affiliateLink}</div>
      <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px">Your affiliate code</div>
      <div style="font-size:16px;font-weight:800;color:#0f172a;font-family:monospace;letter-spacing:2px">${affiliateCode}</div>
    </div>

    <p style="font-size:14px;color:#334155;line-height:1.7;margin:0 0 14px">
      Share this link with business owners — boutiques, salons, retailers, restaurants, service providers. When someone registers through your link and upgrades to Premium, you earn a commission. Payouts are made via Mobile Money or bank transfer.
    </p>

    <p style="font-size:14px;color:#334155;line-height:1.7;margin:0 0 14px">
      The easiest thing to tell them: <em>"Try it free for 30 days, no credit card needed."</em> That removes all friction.
    </p>

    <p style="font-size:14px;color:#334155;line-height:1.7;margin:0 0 28px">
      If you have any questions, just reply to this email or reach us on WhatsApp at +1 304 503 3113 (Mon–Sat, 7am–9pm).
    </p>

    <!-- Simple sign-off -->
    <p style="font-size:14px;color:#334155;margin:0 0 4px">Good luck,</p>
    <p style="font-size:14px;font-weight:600;color:#0f172a;margin:0 0 32px">The ShopTrack Team</p>

    <!-- Minimal footer -->
    <div style="border-top:1px solid #e2e8f0;padding-top:14px">
      <p style="font-size:11px;color:#94a3b8;margin:0;line-height:1.6">
        ShopTrack &nbsp;&bull;&nbsp;
        <a href="https://shoptrack.org" style="color:#64748b;text-decoration:none">shoptrack.org</a>
        &nbsp;&bull;&nbsp; support@shoptrack.work
      </p>
    </div>

  </div>
</body>
</html>`;
}

function buildText(firstName, affiliateCode, affiliateLink) {
  return `Hi ${firstName},

Your ShopTrack affiliate application has been approved. You can start referring businesses right away.

YOUR REFERRAL LINK:
${affiliateLink}

YOUR AFFILIATE CODE: ${affiliateCode}

Share this link with business owners — boutiques, salons, retailers, restaurants, service providers. When someone registers through your link and upgrades to Premium, you earn a commission. Payouts are made via Mobile Money or bank transfer.

The easiest thing to tell them: "Try it free for 30 days, no credit card needed."

Questions? Reply to this email or WhatsApp us at +1 304 503 3113 (Mon-Sat, 7am-9pm).

Good luck,
The ShopTrack Team
shoptrack.org | support@shoptrack.work`;
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { name, email, affiliate_code, social_handle } = body;

  if (!email || !affiliate_code) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'email and affiliate_code are required' }) };
  }

  const BREVO_API_KEY = process.env.BREVO_API_KEY;
  if (!BREVO_API_KEY) {
    console.error('[aff-approve-email] BREVO_API_KEY not configured');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Email service not configured' }) };
  }

  const firstName     = (name || 'there').split(' ')[0];
  const affiliateLink = `https://shoptrack.org/?aff=${encodeURIComponent(affiliate_code)}`;

  const payload = {
    sender:      { name: 'ShopTrack', email: 'support@shoptrack.work' },
    to:          [{ email, name: name || firstName }],
    replyTo:     { email: 'support@shoptrack.work' },
    subject:     `Your ShopTrack affiliate link is ready`,
    htmlContent: buildHtml(firstName, affiliate_code, affiliateLink),
    textContent: buildText(firstName, affiliate_code, affiliateLink),
    // Mark as transactional so Brevo routes it correctly
    tags:        ['affiliate-approval'],
    headers: {
      'X-Mailin-custom': 'transactional',
    },
  };

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY },
      body:    JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[aff-approve-email] Brevo error:', response.status, JSON.stringify(data));
      return { statusCode: response.status, headers, body: JSON.stringify({ error: data.message || data.code || 'Brevo API error', brevo: data }) };
    }

    console.log('[aff-approve-email] Sent to', email, '| code:', affiliate_code, '| messageId:', data.messageId);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, messageId: data.messageId }) };

  } catch (err) {
    console.error('[aff-approve-email] Error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
