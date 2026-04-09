// netlify/functions/aff-approve-email.js
// Sends a branded approval email to an affiliate with their unique referral link.
// Called by the SA from the Affiliates page after approving an application.
//
// Env vars required:
//   BREVO_API_KEY  →  xkeysib-xxxxxxxxxxxx  (from brevo.com)
//
// Body: { name, email, affiliate_code, social_handle }

function buildHtml(name, affiliateCode, affiliateLink, socialHandle) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
  <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">

    <!-- Hero -->
    <div style="background:linear-gradient(135deg,#4f46e5,#6366f1);padding:36px 32px;text-align:center">
      <div style="font-size:32px;font-weight:900;color:#fff;letter-spacing:-.5px">ShopTrack</div>
      <div style="font-size:13px;color:rgba(255,255,255,.7);margin-top:4px">Affiliate Program</div>
      <div style="width:48px;height:3px;background:#10b981;margin:16px auto 0;border-radius:2px"></div>
    </div>

    <!-- Body -->
    <div style="padding:28px 32px">

      <!-- Greeting -->
      <p style="font-size:20px;font-weight:800;color:#0f172a;margin:0 0 6px">🎉 You're approved, ${name}!</p>
      <p style="font-size:13px;color:#475569;margin:0 0 24px;line-height:1.6">
        Welcome to the ShopTrack Affiliate Program. Your application has been reviewed and approved.
        You can start earning commissions immediately — every business that signs up through your link earns you a commission.
      </p>

      <!-- Affiliate Link Box -->
      <div style="background:#eef2ff;border:2px solid #c7d2fe;border-radius:12px;padding:20px 24px;margin-bottom:20px;text-align:center">
        <div style="font-size:11px;font-weight:700;color:#6366f1;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px">YOUR UNIQUE REFERRAL LINK</div>
        <div style="background:#fff;border:1px solid #c7d2fe;border-radius:8px;padding:12px 16px;margin-bottom:12px">
          <a href="${affiliateLink}" style="font-size:14px;font-weight:700;color:#4f46e5;text-decoration:none;word-break:break-all">${affiliateLink}</a>
        </div>
        <div style="font-size:11px;font-weight:700;color:#64748b;margin-bottom:4px">YOUR AFFILIATE CODE</div>
        <div style="display:inline-block;background:#4f46e5;color:#fff;font-size:18px;font-weight:900;letter-spacing:2px;padding:8px 20px;border-radius:8px;font-family:monospace">${affiliateCode}</div>
      </div>

      <!-- How It Works -->
      <div style="background:#10b981;border-radius:6px;padding:7px 12px;margin-bottom:14px">
        <span style="font-size:10px;font-weight:700;color:#fff;letter-spacing:1px">HOW IT WORKS</span>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
        <tr>
          <td style="width:36px;vertical-align:top;padding:10px 0">
            <div style="width:32px;height:32px;background:#eef2ff;border-radius:8px;text-align:center;line-height:32px;font-size:16px;font-weight:900;color:#4f46e5">1</div>
          </td>
          <td style="padding:10px 0 10px 12px;border-bottom:1px solid #e2e8f0">
            <div style="font-size:13px;font-weight:700;color:#1e293b;margin-bottom:2px">Share your referral link</div>
            <div style="font-size:12px;color:#64748b;line-height:1.5">Post it on your social media, stories, WhatsApp, or website. Any business that clicks your link is tracked to you.</div>
          </td>
        </tr>
        <tr>
          <td style="width:36px;vertical-align:top;padding:10px 0">
            <div style="width:32px;height:32px;background:#eef2ff;border-radius:8px;text-align:center;line-height:32px;font-size:16px;font-weight:900;color:#4f46e5">2</div>
          </td>
          <td style="padding:10px 0 10px 12px;border-bottom:1px solid #e2e8f0">
            <div style="font-size:13px;font-weight:700;color:#1e293b;margin-bottom:2px">They sign up and subscribe</div>
            <div style="font-size:12px;color:#64748b;line-height:1.5">When a business registers through your link and upgrades to Premium, your commission is recorded automatically.</div>
          </td>
        </tr>
        <tr>
          <td style="width:36px;vertical-align:top;padding:10px 0">
            <div style="width:32px;height:32px;background:#eef2ff;border-radius:8px;text-align:center;line-height:32px;font-size:16px;font-weight:900;color:#4f46e5">3</div>
          </td>
          <td style="padding:10px 0 10px 12px">
            <div style="font-size:13px;font-weight:700;color:#1e293b;margin-bottom:2px">You get paid</div>
            <div style="font-size:12px;color:#64748b;line-height:1.5">Commissions are paid out via Mobile Money or bank transfer. The ShopTrack team will contact you when a payout is ready.</div>
          </td>
        </tr>
      </table>

      <!-- Tips Box -->
      <div style="background:#fffbeb;border-left:4px solid #f59e0b;border-radius:0 8px 8px 0;padding:14px 16px;margin-bottom:24px">
        <div style="font-size:12px;font-weight:700;color:#92400e;margin-bottom:6px">💡 TIPS FOR SUCCESS</div>
        <div style="font-size:12px;color:#92400e;line-height:1.7">
          • Share your link with boutiques, salons, retailers, and service businesses<br>
          • Tell them about the free 30-day trial — no credit card needed<br>
          • Post on Instagram, TikTok, and WhatsApp for the best reach<br>
          • The more you share, the more you earn
        </div>
      </div>

      <!-- CTA -->
      <div style="background:#064e3b;border-radius:12px;padding:24px;text-align:center">
        <p style="font-size:14px;font-weight:700;color:#d1fae5;margin:0 0 6px">Start sharing your link today</p>
        <p style="font-size:12px;color:#6ee7b7;margin:0 0 16px;line-height:1.6">Every business owner you help is a commission in your pocket.</p>
        <a href="${affiliateLink}"
           style="display:inline-block;background:#10b981;color:#064e3b;font-size:14px;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:8px">
          Copy My Referral Link →
        </a>
        <p style="font-size:11px;color:#6ee7b7;margin:14px 0 0">
          Questions? Contact us at <a href="mailto:support@shoptrack.work" style="color:#10b981;text-decoration:none">support@shoptrack.work</a>
        </p>
      </div>

    </div>

    <!-- Footer -->
    <div style="background:#f8fafc;padding:14px 32px;border-top:1px solid #e2e8f0;text-align:center">
      <p style="font-size:10px;color:#94a3b8;margin:0">
        You are receiving this because your ShopTrack affiliate application was approved.<br>
        &copy; 2026 ShopTrack &nbsp;&bull;&nbsp;
        <a href="https://shoptrack.org" style="color:#6366f1;text-decoration:none">shoptrack.org</a>
      </p>
    </div>

  </div>
</body>
</html>`;
}

function buildText(name, affiliateCode, affiliateLink) {
  return `Hello ${name},

Congratulations — your ShopTrack affiliate application has been approved!

YOUR REFERRAL LINK:
${affiliateLink}

YOUR AFFILIATE CODE: ${affiliateCode}

HOW IT WORKS:
1. Share your link with business owners (boutiques, salons, retailers, service providers)
2. When they sign up and upgrade to Premium through your link, you earn a commission
3. Commissions are paid via Mobile Money or bank transfer

TIPS:
- Mention the free 30-day trial — no credit card needed
- Post on Instagram, TikTok, and WhatsApp for the best reach
- The more businesses you refer, the more you earn

Questions? Contact us:
Email: support@shoptrack.work
WhatsApp: +1 304 503 3113 (Mon-Sat, 7am-9pm)

— The ShopTrack Team
shoptrack.org`;
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

  const firstName     = (name || 'Affiliate').split(' ')[0];
  const affiliateLink = `https://shoptrack.org/?aff=${encodeURIComponent(affiliate_code)}`;

  const payload = {
    sender:      { name: 'ShopTrack Affiliates', email: 'support@shoptrack.work' },
    to:          [{ email, name: name || firstName }],
    replyTo:     { email: 'support@shoptrack.work' },
    subject:     `🎉 You're approved — here's your ShopTrack referral link`,
    htmlContent: buildHtml(firstName, affiliate_code, affiliateLink, social_handle || ''),
    textContent: buildText(firstName, affiliate_code, affiliateLink),
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
      return { statusCode: response.status, headers, body: JSON.stringify({ error: data.message || 'Brevo API error' }) };
    }

    console.log('[aff-approve-email] Approval email sent to', email, '| code:', affiliate_code, '| messageId:', data.messageId);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, messageId: data.messageId }) };

  } catch (err) {
    console.error('[aff-approve-email] Error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
