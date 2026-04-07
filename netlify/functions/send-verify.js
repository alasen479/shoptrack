// netlify/functions/send-verify.js
// Sends a 6-digit OTP to new signups via Resend — bilingual (EN / FR)
// Env vars: RESEND_API_KEY

const _emailLog = {};
const _ipLog    = {};
function isRateLimited(email, ip) {
  const now    = Date.now();
  const window = 10 * 60_000;
  const maxPerEmail = 3;
  const maxPerIp    = 10;
  if (!_emailLog[email]) _emailLog[email] = [];
  if (!_ipLog[ip])       _ipLog[ip]       = [];
  _emailLog[email] = _emailLog[email].filter(t => now - t < window);
  _ipLog[ip]       = _ipLog[ip].filter(t => now - t < window);
  if (_emailLog[email].length >= maxPerEmail) return 'email';
  if (_ipLog[ip].length >= maxPerIp)          return 'ip';
  _emailLog[email].push(now);
  _ipLog[ip].push(now);
  return false;
}

function buildHtml(firstName, bizName, token, isFrench) {
  const greeting   = isFrench ? `Bonjour ${firstName}\u00a0!` : `Hi ${firstName}! 👋`;
  const intro      = isFrench
    ? `Bienvenue sur ShopTrack\u00a0! Vous n'êtes plus qu'à une étape de la création de <strong>${bizName}</strong>.`
    : `Welcome to ShopTrack! You're one step away from setting up <strong>${bizName}</strong>.`;
  const codeLabel  = isFrench ? `Votre code de vérification` : `Your Verification Code`;
  const expiry     = isFrench ? `Expire dans 24 heures` : `Expires in 24 hours`;
  const instruction= isFrench
    ? `Saisissez ce code dans ShopTrack pour vérifier votre adresse e-mail et démarrer votre <strong>essai gratuit de 30 jours</strong>.`
    : `Enter this code in the ShopTrack app to verify your email and start your <strong>free 30-day trial</strong>.`;
  const ignore     = isFrench
    ? `Si vous n'avez pas créé de compte ShopTrack, ignorez cet e-mail.`
    : `If you didn't create a ShopTrack account, please ignore this email.`;
  const subject    = isFrench
    ? `${token} — Votre code de vérification ShopTrack`
    : `${token} — Your ShopTrack verification code`;

  return {
    subject,
    html: `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
  <div style="max-width:480px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:32px;text-align:center">
      <div style="font-size:36px;margin-bottom:8px">🛍️</div>
      <div style="font-size:24px;font-weight:900;color:#fff;letter-spacing:-.5px">ShopTrack</div>
      <div style="font-size:12px;color:rgba(255,255,255,.7);margin-top:4px">Business Management Platform</div>
    </div>
    <div style="padding:32px">
      <p style="font-size:18px;font-weight:700;color:#0f172a;margin:0 0 8px">${greeting}</p>
      <p style="font-size:14px;color:#475569;margin:0 0 24px;line-height:1.6">${intro}</p>
      <div style="background:#f8fafc;border:2px dashed #e2e8f0;border-radius:12px;padding:28px;text-align:center;margin-bottom:24px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.4px;color:#94a3b8;margin-bottom:10px">${codeLabel}</div>
        <div style="font-size:44px;font-weight:900;color:#6366f1;letter-spacing:12px;font-family:monospace">${token}</div>
        <div style="font-size:11px;color:#94a3b8;margin-top:10px">${expiry}</div>
      </div>
      <p style="font-size:13px;color:#64748b;line-height:1.6;margin:0 0 16px">${instruction}</p>
      <p style="font-size:11px;color:#94a3b8;margin:0">${ignore}</p>
    </div>
    <div style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0;text-align:center">
      <p style="font-size:11px;color:#94a3b8;margin:0">
        ShopTrack · <a href="https://shoptrack.org" style="color:#6366f1;text-decoration:none">shoptrack.org</a>
      </p>
    </div>
  </div>
</body>
</html>`,
    text: isFrench
      ? `Bonjour ${firstName},\n\nBienvenue sur ShopTrack !\n\nVotre code de vérification est : ${token}\n\nCe code expire dans 24 heures.\n\nSi vous n'avez pas créé de compte ShopTrack, ignorez cet e-mail.\n\n— L'équipe ShopTrack`
      : `Hi ${firstName},\n\nWelcome to ShopTrack!\n\nYour verification code is: ${token}\n\nThis code expires in 24 hours.\n\nIf you didn't sign up for ShopTrack, please ignore this email.\n\n— The ShopTrack Team`,
  };
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { email, name, bizName, token, lang } = body;
  if (!email || !token) return { statusCode: 400, headers, body: JSON.stringify({ error: 'email and token are required' }) };

  const clientIp = event.headers['x-forwarded-for']?.split(',')[0].trim() || event.headers['client-ip'] || 'unknown';
  const limited  = isRateLimited(email.toLowerCase(), clientIp);
  if (limited === 'email') return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many verification emails sent. Please wait 10 minutes.' }) };
  if (limited === 'ip')    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many requests. Please wait a moment.' }) };

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Email service not configured.' }) };

  const isFrench  = (lang || 'en').toLowerCase() === 'fr';
  const firstName = name ? name.split(' ')[0] : (isFrench ? 'là' : 'there');
  const business  = bizName || 'your business';

  const { subject, html, text } = buildHtml(firstName, business, token, isFrench);

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    'ShopTrack <noreply@shoptrack.org>',
        to:      [email],
        subject,
        html,
        text,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[send-verify] Resend error:', response.status, JSON.stringify(data));
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: 'HTTP ' + response.status + ' — ' + (data.message || data.name || JSON.stringify(data)), code: response.status }) };
    }

    console.log('[send-verify] OTP sent to', email, '| lang:', lang || 'en', '| Resend ID:', data.id);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, id: data.id }) };

  } catch (err) {
    console.error('[send-verify] error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
