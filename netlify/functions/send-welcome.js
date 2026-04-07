// netlify/functions/send-welcome.js
// Sends the Day-1 welcome email via Brevo after OTP verification is complete.
// Attaches the language-appropriate Quick Start Guide PDF (served from /public/docs/).
//
// Env vars needed in Netlify dashboard → Site configuration → Environment variables:
//   BREVO_API_KEY  →  xkeysib-xxxxxxxxxxxx  (from brevo.com → SMTP & API → API Keys)
//
// Trigger: call this function from app.js immediately after a successful OTP verification.
// Body: { email, firstName, lang }   (lang = 'fr' | 'en', defaults to 'en')

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── PDF attachment helper ─────────────────────────────────────────────────────
// Reads a PDF from /public/docs/ and returns it as a base64 string.
// Falls back gracefully if the file is missing so email still sends without attachment.
function loadPdf(filename) {
  try {
    const filePath = path.join(__dirname, '../../public/docs', filename);
    return fs.readFileSync(filePath).toString('base64');
  } catch (err) {
    console.warn(`[send-welcome] PDF not found: ${filename} — sending without attachment`);
    return null;
  }
}

// ── Email HTML builder ────────────────────────────────────────────────────────
function buildHtml(firstName, isFrench) {
  const greeting    = isFrench ? `Bonjour ${firstName}\u00a0!` : `Hello ${firstName}!`;
  const intro1      = isFrench
    ? `Votre essai gratuit de 30\u00a0jours est maintenant actif. Tout est pr\u00eat \u2014 sans frais d\u2019installation, sans carte bancaire, sans connaissances techniques requises.`
    : `Your free 30-day trial is now active. Everything is ready \u2014 no setup fees, no credit card, no technical knowledge required.`;
  const intro2      = isFrench
    ? `Ce mail est votre point de d\u00e9part. Lisez-le une fois, suivez les cinq \u00e9tapes ci-dessous, et \u00e0 la fin de cette semaine votre entreprise fonctionnera sur de vraies donn\u00e9es pour la premi\u00e8re fois.`
    : `This email is your starting point. Read it once, follow the five steps below, and by the end of this week your business will be running on real data for the first time.`;
  const stepsHeader = isFrench ? `VOTRE PREMI\u00c8RE SEMAINE \u2014 CINQ \u00c9TAPES` : `YOUR FIRST WEEK \u2014 FIVE STEPS`;

  const steps = isFrench ? [
    [`Compl\u00e9tez votre profil d\u2019entreprise`,        `Param\u00e8tres \u2192 Profil d\u2019entreprise. Ajoutez votre logo, num\u00e9ro WhatsApp, adresse, note de facture, devise et taux de taxe.`],
    [`Ajoutez vos produits \u00e0 l\u2019inventaire`,         `Saisissez le vrai prix de revient \u2014 frais d\u2019exp\u00e9dition et de douane inclus. D\u00e9finissez une alerte stock minimum pour chaque article.`],
    [`Enregistrez votre premi\u00e8re vente`,                `Ventes \u2192 + Nouvelle vente. Enregistrez l\u2019article, le paiement, et envoyez la facture par WhatsApp en un tap.`],
    [`Configurez les r\u00e9servations en ligne`,            `Services \u2192 + Ajouter un service. Partagez votre lien de r\u00e9servation sur Instagram et WhatsApp.`],
    [`Enregistrez les d\u00e9penses et lisez votre compte de r\u00e9sultat`, `D\u00e9penses \u2192 + Ajouter. Puis Comptabilit\u00e9 \u2192 Compte de r\u00e9sultat \u2192 Cette semaine pour voir votre vrai b\u00e9n\u00e9fice.`],
  ] : [
    [`Complete your Business Profile`,        `Settings \u2192 Business Profile. Add your logo, WhatsApp number, address, invoice note, currency, and tax rate.`],
    [`Add your products to Inventory`,        `Enter the true cost price \u2014 including shipping and duties. Set a minimum stock alert for each item.`],
    [`Record your first sale`,                `Sales \u2192 + New Sale. Add the items, set the payment, and send the invoice on WhatsApp in one tap.`],
    [`Set up online bookings`,                `Services \u2192 + Add Service. Share your booking link on Instagram and WhatsApp Status.`],
    [`Record expenses and read your P&L`,     `Expenses \u2192 + Add Expense. Then Accounting \u2192 Profit & Loss \u2192 This Week to see your real net profit.`],
  ];

  const warnText = isFrench
    ? `Le chiffre d\u2019affaires n\u2019est pas le b\u00e9n\u00e9fice. Vous devez enregistrer les d\u00e9penses pour que ShopTrack affiche votre b\u00e9n\u00e9fice net r\u00e9el.`
    : `Revenue is not profit. You must record expenses for ShopTrack to show your real net profit.`;

  const attachNote = isFrench
    ? `Votre <strong>Guide de D\u00e9marrage Rapide</strong> est en pi\u00e8ce jointe \u2014 4\u00a0pages, jour par jour.`
    : `Your <strong>Quick Start Guide</strong> is attached \u2014 4 pages, day by day.`;

  const supportHeader = isFrench ? `NOUS SOMMES L\u00c0` : `WE ARE HERE`;
  const supportRows   = isFrench ? [
    [`WhatsApp`, `Lun\u2013Sam, 7h\u201321h`],
    [`E-mail`,   `support@shoptrack.work`],
    [`Site web`, `shoptrack.org`],
  ] : [
    [`WhatsApp`, `Mon\u2013Sat, 7am\u20139pm`],
    [`Email`,    `support@shoptrack.work`],
    [`Website`,  `shoptrack.org`],
  ];

  const ctaText = isFrench
    ? `Ouvrir ShopTrack \u2192`
    : `Open ShopTrack \u2192`;
  const ctaSub  = isFrench
    ? `En une semaine, vous en saurez plus sur votre entreprise que vous n\u2019en avez su depuis des ann\u00e9es.`
    : `In one week you will know more about your business than you have in years.`;

  const footerText = isFrench
    ? `Vous recevez cet e-mail car vous avez cr\u00e9\u00e9 un compte ShopTrack.`
    : `You are receiving this because you registered a ShopTrack account.`;

  const stepsHtml = steps.map(([title, detail], i) => `
    <tr>
      <td style="width:36px;vertical-align:top;padding:10px 0 10px 0">
        <div style="width:32px;height:32px;background:#eef2ff;border-radius:8px;text-align:center;line-height:32px;font-size:16px;font-weight:900;color:#4f46e5">${i + 1}</div>
      </td>
      <td style="padding:10px 0 10px 12px;border-bottom:1px solid #e2e8f0">
        <div style="font-size:13px;font-weight:700;color:#1e293b;margin-bottom:2px">${title}</div>
        <div style="font-size:12px;color:#64748b;line-height:1.5">${detail}</div>
      </td>
    </tr>`).join('');

  const supportHtml = supportRows.map(([label, value]) => `
    <td style="width:33%;padding:0 6px;vertical-align:top">
      <div style="background:#f1f5f9;border-radius:8px;padding:10px">
        <div style="font-size:11px;font-weight:700;color:#1e293b;margin-bottom:3px">${label}</div>
        <div style="font-size:11px;color:#64748b">${value}</div>
      </div>
    </td>`).join('');

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
      <div style="font-size:13px;color:rgba(255,255,255,.7);margin-top:4px">Business Management Platform</div>
      <div style="width:48px;height:3px;background:#10b981;margin:16px auto 0;border-radius:2px"></div>
    </div>

    <!-- Body -->
    <div style="padding:28px 32px">

      <!-- Greeting -->
      <p style="font-size:18px;font-weight:700;color:#0f172a;margin:0 0 6px">${greeting}</p>
      <p style="font-size:13px;color:#475569;margin:0 0 8px;line-height:1.6">${intro1}</p>
      <p style="font-size:13px;color:#475569;margin:0 0 24px;line-height:1.6">${intro2}</p>

      <!-- Steps -->
      <div style="background:#10b981;border-radius:6px;padding:7px 12px;margin-bottom:14px">
        <span style="font-size:10px;font-weight:700;color:#fff;letter-spacing:1px">${stepsHeader}</span>
      </div>
      <table style="width:100%;border-collapse:collapse">
        ${stepsHtml}
      </table>

      <!-- Warning -->
      <div style="background:#fffbeb;border-left:4px solid #f59e0b;border-radius:0 8px 8px 0;padding:12px 14px;margin:20px 0">
        <span style="font-size:12px;font-weight:700;color:#92400e">! &nbsp;</span>
        <span style="font-size:12px;color:#92400e">${warnText}</span>
      </div>

      <!-- Attachment note -->
      <div style="background:#eef2ff;border-radius:8px;padding:14px 16px;margin-bottom:20px">
        <p style="font-size:12px;color:#4f46e5;margin:0;line-height:1.5">&#128203; &nbsp;${attachNote}</p>
      </div>

      <!-- Support -->
      <div style="background:#10b981;border-radius:6px;padding:7px 12px;margin-bottom:14px">
        <span style="font-size:10px;font-weight:700;color:#fff;letter-spacing:1px">${supportHeader}</span>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        <tr>${supportHtml}</tr>
      </table>

      <!-- CTA -->
      <div style="background:#064e3b;border-radius:12px;padding:24px;text-align:center">
        <p style="font-size:13px;color:#d1fae5;margin:0 0 14px;line-height:1.6">${ctaSub}</p>
        <a href="https://shoptrack.org"
           style="display:inline-block;background:#10b981;color:#064e3b;font-size:14px;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:8px">
          ${ctaText}
        </a>
        <p style="font-size:11px;color:#6ee7b7;margin:14px 0 0">
          shoptrack.org &nbsp;&bull;&nbsp; support@shoptrack.work
        </p>
      </div>

    </div>

    <!-- Footer -->
    <div style="background:#f8fafc;padding:14px 32px;border-top:1px solid #e2e8f0;text-align:center">
      <p style="font-size:10px;color:#94a3b8;margin:0">
        ${footerText}<br>
        &copy; 2026 ShopTrack &nbsp;&bull;&nbsp;
        <a href="https://shoptrack.org" style="color:#6366f1;text-decoration:none">shoptrack.org</a>
      </p>
    </div>

  </div>
</body>
</html>`;
}

// ── Plain-text fallback ───────────────────────────────────────────────────────
function buildText(firstName, isFrench) {
  if (isFrench) {
    return `Bonjour ${firstName},

Votre essai gratuit de 30 jours est maintenant actif sur ShopTrack.

VOS 5 PREMIÈRES ÉTAPES :
1. Complétez votre profil d'entreprise (Paramètres → Profil)
2. Ajoutez vos produits à l'inventaire avec le vrai prix de revient
3. Enregistrez votre première vente et envoyez la facture par WhatsApp
4. Configurez votre page de réservation en ligne
5. Enregistrez vos dépenses et lisez votre compte de résultat

Votre Guide de Démarrage Rapide est en pièce jointe.

Assistance : support@shoptrack.work | shoptrack.org
Lun–Sam, 7h–21h

— L'équipe ShopTrack`;
  }
  return `Hello ${firstName},

Your free 30-day trial is now active on ShopTrack.

YOUR 5 FIRST STEPS:
1. Complete your Business Profile (Settings → Business Profile)
2. Add your products to Inventory with the true cost price
3. Record your first sale and send the invoice on WhatsApp
4. Set up your online booking page
5. Record expenses and read your Profit & Loss report

Your Quick Start Guide is attached.

Support: support@shoptrack.work | shoptrack.org
Mon-Sat, 7am-9pm

— The ShopTrack Team`;
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { email, firstName, lang } = body;

  if (!email) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'email is required' }) };
  }

  const BREVO_API_KEY = process.env.BREVO_API_KEY;
  if (!BREVO_API_KEY) {
    console.error('[send-welcome] BREVO_API_KEY not configured');
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: 'Email service not configured. Add BREVO_API_KEY to Netlify environment variables.' }),
    };
  }

  const isFrench  = (lang || 'en').toLowerCase() === 'fr';
  const name      = firstName || 'there';

  // ── Determine which PDFs to attach ─────────────────────────────────────────
  const quickStartFile = isFrench
    ? 'ShopTrack_Guide_Demarrage_Rapide_FR.pdf'
    : 'ShopTrack_Quick_Start_Guide_EN.pdf';

  const manualFile = isFrench
    ? 'ShopTrack_Manuel_Proprietaire_FR.pdf'
    : 'ShopTrack_Owner_Manual_EN.pdf';

  // ── Load PDFs as base64 ─────────────────────────────────────────────────────
  const attachments = [];
  const quickStartB64 = loadPdf(quickStartFile);
  const manualB64     = loadPdf(manualFile);

  if (quickStartB64) attachments.push({ name: quickStartFile, content: quickStartB64 });
  if (manualB64)     attachments.push({ name: manualFile,     content: manualB64 });

  // ── Subject line ────────────────────────────────────────────────────────────
  const subject = isFrench
    ? `Bienvenue sur ShopTrack\u00a0\u2014 votre guide est en pi\u00e8ce jointe`
    : `Welcome to ShopTrack \u2014 your guide is attached`;

  // ── Build Brevo payload ─────────────────────────────────────────────────────
  const payload = {
    sender:      { name: 'ShopTrack Support', email: 'support@shoptrack.work' },
    to:          [{ email }],
    replyTo:     { email: 'support@shoptrack.work' },
    subject,
    htmlContent: buildHtml(name, isFrench),
    textContent: buildText(name, isFrench),
    ...(attachments.length > 0 && { attachment: attachments }),
  };

  // ── Send via Brevo REST API ─────────────────────────────────────────────────
  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key':      BREVO_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[send-welcome] Brevo API error:', response.status, JSON.stringify(data));
      return {
        statusCode: response.status, headers,
        body: JSON.stringify({ error: data.message || 'Brevo API error', details: data }),
      };
    }

    console.log('[send-welcome] Welcome email sent to', email,
      '| lang:', lang || 'en',
      '| attachments:', attachments.map(a => a.name).join(', ') || 'none',
      '| Brevo messageId:', data.messageId);

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ success: true, messageId: data.messageId }),
    };

  } catch (err) {
    console.error('[send-welcome] Function error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
