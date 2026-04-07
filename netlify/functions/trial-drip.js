/**
 * trial-drip.js  —  Netlify Scheduled Function
 *
 * Runs every day at 08:00 UTC via cron.
 * For each active-trial business, calculates days since signup and
 * sends the correct drip email if it hasn't been sent yet.
 *
 * Schedule config goes in netlify.toml:
 *   [functions.trial-drip]
 *   schedule = "0 8 * * *"
 *
 * Required env vars (set in Netlify dashboard):
 *   SUPABASE_URL         — your project URL
 *   SUPABASE_SERVICE_KEY — service role key (not anon — needs write access)
 *   RESEND_API_KEY       — from resend.com
 *   FROM_EMAIL           — e.g. "ShopTrack <hello@shoptrack.work>"
 *   SITE_URL             — e.g. "https://shoptrack.work"
 */

// No npm dependencies — uses native fetch for both Supabase and Resend
// Supabase REST API helper
function sbClient(url, key) {
  const base = url.replace(/\/$/, '') + '/rest/v1';
  async function query(table, params) {
    // Build PostgREST query — filter values are NOT encoded (operators like not.is.null must be raw)
    const qs = Object.entries(params||{}).map(([k,v])=>k+'='+v).join('&');
    const res = await fetch(base+'/'+table+(qs?'?'+qs:''), {
      headers: {
        'apikey': key,
        'Authorization': 'Bearer '+key,
        'Content-Type': 'application/json',
      }
    });
    if (!res.ok) throw new Error('Supabase query failed: '+res.status+' '+await res.text());
    return res.json();
  }
  async function update(table, match, data) {
    // Do NOT encodeURIComponent — Supabase IDs with dashes break when encoded
    const qs = Object.entries(match).map(([k,v])=>k+'=eq.'+v).join('&');
    const res = await fetch(base+'/'+table+'?'+qs, {
      method: 'PATCH',
      headers: {
        'apikey': key,
        'Authorization': 'Bearer '+key,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Supabase update failed: '+res.status+' '+await res.text());
  }
  return { query, update };
}

// Resend REST API helper
async function sendEmail(apiKey, payload) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer '+apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Resend error: '+(data.message||res.status));
  return data;
}

// ── Drip sequence definition ─────────────────────────────────────
// Each entry: { day, key, subject_en, subject_fr, goal }
// 'key' is stored in the drip_sent JSON so we never resend.
const DRIP_SEQUENCE = [
  {
    day: 0,
    key: 'd0_welcome',
    goal: 'activation',
    subject_en: 'Your ShopTrack is ready — here\'s your 5-minute setup',
    subject_fr: 'Votre ShopTrack est prêt — voici votre guide de démarrage',
  },
  {
    day: 1,
    key: 'd1_first_sale',
    goal: 'activation',
    subject_en: 'Did you record your first sale?',
    subject_fr: 'Avez-vous enregistré votre première vente ?',
  },
  {
    day: 4,
    key: 'd4_week_report',
    goal: 'show_value',
    subject_en: 'Your first week report is ready',
    subject_fr: 'Votre rapport de première semaine est prêt',
  },
  {
    day: 10,
    key: 'd10_features',
    goal: 'feature_discovery',
    subject_en: '3 features most ShopTrack businesses miss',
    subject_fr: '3 fonctionnalités que la plupart des utilisateurs manquent',
  },
  {
    day: 20,
    key: 'd20_urgency',
    goal: 'urgency',
    subject_en: '10 days left — here\'s what you\'ve built',
    subject_fr: 'Plus que 10 jours — voici ce que vous avez construit',
  },
  {
    day: 27,
    key: 'd27_hard_cta',
    goal: 'hard_cta',
    subject_en: '3 days left — here\'s how to keep going',
    subject_fr: 'Plus que 3 jours — voici comment continuer',
  },
  {
    day: 30,
    key: 'd30_expired',
    goal: 'urgency',
    subject_en: 'Your trial ended — your data is safe for 60 days',
    subject_fr: 'Votre essai est terminé — vos données sont conservées 60 jours',
  },
];

// ── HTML email builder ───────────────────────────────────────────
function buildEmail({ key, firstName, bizName, lang, stats, siteUrl }) {
  const fr = lang === 'fr';
  const name = firstName || (fr ? 'bonjour' : 'there');
  const hi = fr ? `Bonjour ${name}` : `Hi ${name}`;
  const footerLine = fr
    ? `© 2026 ShopTrack · <a href="${siteUrl}" style="color:#6366f1">shoptrack.org</a> · info@shoptrack.work`
    : `© 2026 ShopTrack · <a href="${siteUrl}" style="color:#6366f1">shoptrack.org</a> · info@shoptrack.work`;

  const wrap = (inner) => `<!DOCTYPE html><html lang="${lang || 'en'}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ShopTrack</title></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:32px 0">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">
  <!-- Logo header -->
  <tr><td style="padding-bottom:20px;text-align:center">
    <span style="display:inline-block;background:#6366f1;border-radius:10px;padding:8px 16px;font-size:18px;font-weight:800;color:#fff;letter-spacing:-0.5px">ShopTrack</span>
  </td></tr>
  <!-- Card -->
  <tr><td style="background:#fff;border-radius:14px;padding:36px 40px;border:1px solid #e2e8f0">
    ${inner}
  </td></tr>
  <!-- Footer -->
  <tr><td style="padding:20px 0;text-align:center;font-size:12px;color:#94a3b8">${footerLine}</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  const btn = (url, label) =>
    `<table cellpadding="0" cellspacing="0" style="margin:28px 0">
      <tr><td style="background:#6366f1;border-radius:8px;padding:13px 28px">
        <a href="${url}" style="color:#fff;font-weight:700;font-size:15px;text-decoration:none">${label}</a>
      </td></tr>
    </table>`;

  const statBox = (stats) => {
    if (!stats || (!stats.sales && !stats.customers && !stats.revenue)) return '';
    return `<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8faff;border-radius:10px;border:1px solid #e2e8f0;padding:16px;margin:20px 0">
      <tr>
        <td align="center" style="padding:8px 16px">
          <div style="font-size:24px;font-weight:800;color:#6366f1;font-family:monospace">${stats.sales}</div>
          <div style="font-size:11px;color:#94a3b8;margin-top:2px">${fr ? 'Ventes' : 'Sales'}</div>
        </td>
        <td align="center" style="padding:8px 16px;border-left:1px solid #e2e8f0">
          <div style="font-size:24px;font-weight:800;color:#0ea66e;font-family:monospace">${stats.customers}</div>
          <div style="font-size:11px;color:#94a3b8;margin-top:2px">${fr ? 'Clients' : 'Customers'}</div>
        </td>
        <td align="center" style="padding:8px 16px;border-left:1px solid #e2e8f0">
          <div style="font-size:20px;font-weight:800;color:#0ea66e;font-family:monospace">${stats.revenue}</div>
          <div style="font-size:11px;color:#94a3b8;margin-top:2px">${fr ? 'Chiffre d\'affaires' : 'Revenue'}</div>
        </td>
      </tr>
    </table>`;
  };

  const appUrl = `${siteUrl}`;

  // ── Email bodies per key ─────────────────────────────────────
  const bodies = {

    d0_welcome: wrap(`
      <h1 style="margin:0 0 8px;font-size:22px;color:#1a1e35">${fr ? `${hi} 👋` : `${hi} 👋`}</h1>
      <p style="color:#4a5275;line-height:1.7;margin:0 0 16px">${fr
        ? `Votre compte ShopTrack pour <strong>${bizName}</strong> est prêt. Voici comment démarrer en 5 minutes.`
        : `Your ShopTrack account for <strong>${bizName}</strong> is ready. Here's how to get started in 5 minutes.`
      }</p>
      <table width="100%" cellpadding="0" cellspacing="0">
        ${[
          [fr ? '📦 Ajoutez votre premier produit' : '📦 Add your first product', fr ? 'Allez dans Inventaire → Ajouter un article. Commencez par vos 5 meilleures ventes.' : 'Go to Inventory → Add Item. Start with your 5 best sellers.'],
          [fr ? '💳 Enregistrez votre première vente' : '💳 Record your first sale', fr ? 'Ventes → Nouvelle vente. Votre premier reçu est prêt en 30 secondes.' : 'Sales → New Sale. Your first receipt is ready in 30 seconds.'],
          [fr ? '📱 Activez vos alertes WhatsApp' : '📱 Turn on WhatsApp alerts', fr ? 'Paramètres → Notifications. Vous recevrez une alerte à chaque vente.' : 'Settings → Notifications. Get a WhatsApp alert for every sale.'],
        ].map(([title, desc]) => `
          <tr><td style="padding:10px 0;border-bottom:1px solid #f1f5f9">
            <div style="font-weight:700;color:#1a1e35;margin-bottom:3px">${title}</div>
            <div style="font-size:13px;color:#4a5275">${desc}</div>
          </td></tr>`).join('')}
      </table>
      ${btn(appUrl, fr ? '▶ Ouvrir ShopTrack' : '▶ Open ShopTrack')}
      <p style="font-size:13px;color:#94a3b8;margin:0">${fr
        ? 'Votre essai de 30 jours est en cours. Toutes les fonctionnalités sont incluses, aucune carte bancaire requise.'
        : 'Your 30-day trial is running. All features included, no credit card required.'
      }</p>`),

    d1_first_sale: wrap(`
      <h1 style="margin:0 0 8px;font-size:22px;color:#1a1e35">${hi} 👋</h1>
      <p style="color:#4a5275;line-height:1.7;margin:0 0 16px">${fr
        ? `Voici ce qui se passe dès votre première vente enregistrée sur ShopTrack&nbsp;:`
        : `Here's what happens the moment you record your first sale on ShopTrack:`
      }</p>
      <div style="background:#f0fdf4;border-radius:10px;border:1px solid #bbf7d0;padding:16px 20px;margin:0 0 20px">
        <div style="font-size:15px;font-weight:700;color:#065f46;margin-bottom:6px">📱 ${fr ? 'Vous recevez une alerte WhatsApp en temps réel' : 'You get a live WhatsApp alert'}</div>
        <div style="font-size:13px;color:#065f46;font-style:italic;margin-bottom:8px">"${fr ? `Nouvelle vente — 45 000 XAF — par Sophie"` : `New sale recorded — 45,000 XAF — by Sophie"`}</div>
        <div style="font-size:13px;color:#065f46">${fr
          ? `C'est le moment où ShopTrack devient indispensable. Vous savez exactement ce qui se passe dans votre boutique, même à distance.`
          : `This is the moment ShopTrack becomes essential. You know exactly what's happening in your shop — even when you're not there.`
        }</div>
      </div>
      <p style="color:#4a5275;line-height:1.7;margin:0 0 16px">${fr
        ? `Pour activer cette alerte : Paramètres → Notifications → <strong>Nouvelle vente enregistrée</strong> → cliquez <strong>Envoyer test</strong>. Vous recevrez un message WhatsApp en quelques secondes.`
        : `To activate this alert: Settings → Notifications → <strong>New sale recorded</strong> → click <strong>Send Test</strong>. You'll receive a WhatsApp message within seconds.`
      }</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8faff;border-radius:10px;border:1px solid #e2e8f0;padding:20px;margin-bottom:20px">
        <tr><td>
          <div style="font-size:13px;font-weight:700;color:#6366f1;text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px">${fr ? 'Enregistrez votre première vente — 30 secondes' : 'Record your first sale — 30 seconds'}</div>
          ${[
            [fr ? '1. Cliquez sur Ventes → Nouvelle vente' : '1. Click Sales → New Sale', ''],
            [fr ? '2. Sélectionnez un article et un client' : '2. Select an item and a customer', ''],
            [fr ? '3. Entrez le montant payé et cliquez Enregistrer' : '3. Enter the amount paid and click Save', fr ? 'Le reçu est généré automatiquement.' : 'Receipt is generated automatically. Your WhatsApp alert fires instantly.'],
          ].map(([s, d]) => `<div style="padding:6px 0;color:#1a1e35;font-size:14px">${s}${d ? `<div style="font-size:12px;color:#94a3b8;margin-top:2px">${d}</div>` : ''}</div>`).join('')}
        </td></tr>
      </table>
      ${btn(appUrl, fr ? '▶ Enregistrer ma première vente' : '▶ Record my first sale')}
      <p style="font-size:13px;color:#4a5275;margin:0">${fr
        ? 'Besoin d\'aide ? Répondez à cet e-mail ou WhatsApp : +1 304 503 3113'
        : 'Need help? Reply to this email or WhatsApp: +1 304 503 3113'
      }</p>`),

    d4_week_report: wrap(`
      <h1 style="margin:0 0 8px;font-size:22px;color:#1a1e35">${fr ? `${hi} — votre rapport de première semaine` : `${hi} — your first week report`} 📊</h1>
      <p style="color:#4a5275;line-height:1.7;margin:0 0 8px">${fr
        ? `Voici ce que <strong>${bizName}</strong> a réalisé jusqu\'à présent sur ShopTrack :`
        : `Here's what <strong>${bizName}</strong> has built on ShopTrack so far:`
      }</p>
      ${statBox(stats)}
      ${stats && (stats.sales > 0 || stats.customers > 0) ? `
        <p style="color:#4a5275;line-height:1.7;margin:0 0 20px">${fr
          ? 'Continuez ainsi. Plus vous enregistrez de ventes, plus vos rapports sont précis et plus vous voyez clairement votre bénéfice réel.'
          : 'Keep going. The more sales you record, the more accurate your reports become and the clearer your real profit gets.'
        }</p>` : `
        <p style="color:#4a5275;line-height:1.7;margin:0 0 20px">${fr
          ? 'Il n\'est pas trop tard. Commencez à enregistrer dès aujourd\'hui et votre rapport de la semaine prochaine vous montrera exactement où vous en êtes.'
          : 'It\'s not too late. Start recording today and your report next week will show you exactly where you stand.'
        }</p>`}
      <div style="background:#f0fdf4;border-radius:10px;border:1px solid #bbf7d0;padding:16px;margin:0 0 20px">
        <div style="font-weight:700;color:#065f46;margin-bottom:6px">💡 ${fr ? 'Conseil cette semaine' : 'This week\'s tip'}</div>
        <div style="font-size:13px;color:#065f46;line-height:1.6">${fr
          ? 'Activez les alertes WhatsApp dans Paramètres → Notifications. Vous recevrez un message à chaque vente enregistrée par votre personnel — même si vous n\'êtes pas dans la boutique.'
          : 'Turn on WhatsApp alerts in Settings → Notifications. You\'ll receive a message every time a sale is recorded — even when you\'re not in the shop.'
        }</div>
      </div>
      ${btn(appUrl, fr ? '▶ Voir mes rapports complets' : '▶ View my full reports')}`),

    d10_features: wrap(`
      <h1 style="margin:0 0 8px;font-size:22px;color:#1a1e35">${fr ? `${hi} — 3 fonctionnalités que la plupart manquent` : `${hi} — 3 features most businesses miss`}</h1>
      <p style="color:#4a5275;line-height:1.7;margin:0 0 24px">${fr
        ? `Vous avez maintenant 10 jours de ShopTrack. Voici trois outils peu utilisés qui font une grande différence pour des entreprises comme <strong>${bizName}</strong>.`
        : `You've had ShopTrack for 10 days. Here are three underused tools that make a big difference for businesses like <strong>${bizName}</strong>.`
      }</p>
      ${[
        {
          icon: '🔒',
          en_title: 'Minimum price lock',
          fr_title: 'Verrouillage du prix minimum',
          en_body: 'Set a floor price per product. Staff cannot sell below it — ever. Go to Inventory → Edit Item → Minimum Price.',
          fr_body: 'Définissez un prix plancher par produit. Votre personnel ne peut pas vendre en dessous — jamais. Inventaire → Modifier → Prix minimum.',
        },
        {
          icon: '📊',
          en_title: 'P&L report — your real profit',
          fr_title: 'Compte de résultat — votre vrai bénéfice',
          en_body: 'Go to Reports → Profit & Loss. Select any period. See exactly what you made after all expenses. No spreadsheet needed.',
          fr_body: 'Rapports → Compte de résultat. Sélectionnez une période. Voyez exactement ce que vous avez gagné après toutes les dépenses.',
        },
        {
          icon: '👥',
          en_title: 'Add your staff',
          fr_title: 'Ajoutez votre personnel',
          en_body: 'Go to Settings → Users. Add staff with their own login. They record sales — you see everything, they see nothing they shouldn\'t.',
          fr_body: 'Paramètres → Utilisateurs. Ajoutez votre personnel avec leur propre connexion. Ils enregistrent les ventes — vous voyez tout, ils ne voient que ce qui leur est autorisé.',
        },
      ].map(f => `
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;background:#f8faff;border-radius:10px;border:1px solid #e2e8f0">
          <tr>
            <td style="padding:16px;vertical-align:top;width:40px;font-size:22px">${f.icon}</td>
            <td style="padding:16px 16px 16px 0;vertical-align:top">
              <div style="font-weight:700;color:#1a1e35;margin-bottom:4px">${fr ? f.fr_title : f.en_title}</div>
              <div style="font-size:13px;color:#4a5275;line-height:1.6">${fr ? f.fr_body : f.en_body}</div>
            </td>
          </tr>
        </table>`).join('')}
      ${btn(appUrl, fr ? '▶ Explorer ShopTrack' : '▶ Explore ShopTrack')}`),

    d20_urgency: wrap(`
      <h1 style="margin:0 0 8px;font-size:22px;color:#1a1e35">${fr ? `${hi} — plus que 10 jours` : `${hi} — 10 days left`} ⏰</h1>
      <p style="color:#4a5275;line-height:1.7;margin:0 0 8px">${fr
        ? `Votre essai ShopTrack se termine dans 10 jours. Voici ce que <strong>${bizName}</strong> a construit :`
        : `Your ShopTrack trial ends in 10 days. Here's what <strong>${bizName}</strong> has built:`
      }</p>
      ${statBox(stats)}
      <p style="color:#4a5275;line-height:1.7;margin:0 0 20px">${fr
        ? 'Toutes ces données — chaque vente, chaque client, chaque produit — resteront accessibles après la mise à niveau. Elles disparaissent si vous ne continuez pas.'
        : 'All of this data — every sale, every customer, every product — stays with you when you upgrade. It disappears if you don\'t continue.'
      }</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff7ed;border-radius:10px;border:1px solid #fed7aa;padding:20px;margin:0 0 20px">
        <tr><td>
          <div style="font-weight:700;color:#2dd4a0;margin-bottom:10px">🆓 Gratuit — 0 XAF/mois</div>
          <div style="font-size:13px;color:#065f46;line-height:1.6;margin-bottom:12px">${fr
            ? '1 utilisateur · 30 produits · 30 clients · Ventes et dépenses illimitées'
            : '1 user · 30 products · 30 customers · Unlimited sales & expenses'
          }</div>
          <div style="font-weight:700;color:#5b7fff;margin-bottom:10px">⭐ Premium — 8,900 XAF/mois</div>
          <div style="font-size:13px;color:#1d4ed8;line-height:1.6">${fr
            ? 'Jusqu\'à 5 utilisateurs · Illimité · Studio IA · Locations · Rendez-vous · WhatsApp complet'
            : 'Up to 5 users · Unlimited everything · AI Studio · Rentals · Bookings · Full WhatsApp'
          }</div>
        </td></tr>
      </table>
      ${btn(appUrl, fr ? '▶ Continuer avec ShopTrack' : '▶ Continue with ShopTrack')}
      <p style="font-size:13px;color:#94a3b8;margin:0">${fr
        ? 'Questions ? Répondez à cet e-mail ou WhatsApp : +1 304 503 3113'
        : 'Questions? Reply to this email or WhatsApp: +1 304 503 3113'
      }</p>`),

    d27_hard_cta: wrap(`
      <h1 style="margin:0 0 8px;font-size:22px;color:#dc2626">${fr ? `${hi} — plus que 3 jours` : `${hi} — 3 days left`} 🚨</h1>
      <p style="color:#4a5275;line-height:1.7;margin:0 0 8px">${fr
        ? `Votre essai ShopTrack pour <strong>${bizName}</strong> se termine dans <strong>3 jours</strong>.`
        : `Your ShopTrack trial for <strong>${bizName}</strong> ends in <strong>3 days</strong>.`
      }</p>
      ${statBox(stats)}
      <div style="background:#fef2f2;border-radius:10px;border:1px solid #fecaca;padding:16px;margin:0 0 20px">
        <div style="font-size:13px;color:#dc2626;line-height:1.6">${fr
          ? '⚠ Si vous ne mettez pas à niveau avant la fin de l\'essai, votre accès passe en lecture seule. Vous ne pourrez plus enregistrer de ventes ni de dépenses.'
          : '⚠ If you don\'t upgrade before your trial ends, your access switches to read-only. You won\'t be able to record sales or expenses.'
        }</div>
      </div>
      <p style="color:#4a5275;line-height:1.7;margin:0 0 8px">${fr
        ? 'Mettre à niveau prend 2 minutes. Paiement par Mobile Money, Orange Money ou virement bancaire.'
        : 'Upgrading takes 2 minutes. Payment via Mobile Money, Orange Money, or bank transfer.'
      }</p>
      ${btn(appUrl, fr ? '▶ Mettre à niveau maintenant — garder mes données' : '▶ Upgrade now — keep my data')}
      <p style="font-size:13px;color:#4a5275;margin:0">${fr
        ? 'Gratuit : 0 XAF/mois · Premium : 8,900 XAF/mois · Résiliez à tout moment'
        : 'Free: 0 XAF/mo · Premium: 8,900 XAF/mo · Cancel anytime'
      }</p>`),

    d30_expired: wrap(`
      <h1 style="margin:0 0 8px;font-size:22px;color:#1a1e35">${fr ? `${hi} — votre essai est terminé` : `${hi} — your trial has ended`}</h1>
      <p style="color:#4a5275;line-height:1.7;margin:0 0 8px">${fr
        ? `Votre essai de 30 jours pour <strong>${bizName}</strong> est terminé.`
        : `Your 30-day trial for <strong>${bizName}</strong> has ended.`
      }</p>
      <div style="background:#f0fdf4;border-radius:10px;border:1px solid #bbf7d0;padding:16px;margin:0 0 20px">
        <div style="font-weight:700;color:#065f46;margin-bottom:6px">✅ ${fr ? 'Bonne nouvelle' : 'Good news'}</div>
        <div style="font-size:13px;color:#065f46;line-height:1.6">${fr
          ? 'Toutes vos données — ventes, clients, produits, rapports — sont conservées en sécurité pendant <strong>60 jours</strong>. Elles vous attendent.'
          : 'All your data — sales, customers, products, reports — is kept safely for <strong>60 days</strong>. It\'s all waiting for you.'
        }</div>
      </div>
      ${statBox(stats)}
      <p style="color:#4a5275;line-height:1.7;margin:0 0 20px">${fr
        ? 'Pour continuer à enregistrer des ventes et accéder à tous vos rapports, mettez à niveau en 2 minutes.'
        : 'To continue recording sales and accessing all your reports, upgrade in 2 minutes.'
      }</p>
      ${btn(appUrl, fr ? '▶ Passer à Premium — 8,900 XAF/mois' : '▶ Upgrade to Premium — 8,900 XAF/mo')}
      <p style="font-size:13px;color:#4a5275;margin:0">${fr
        ? 'Des questions ? Répondez à cet e-mail ou contactez-nous sur WhatsApp : +1 304 503 3113'
        : 'Questions? Reply to this email or contact us on WhatsApp: +1 304 503 3113'
      }</p>`),
  };

  return bodies[key] || null;
}

// ── Main handler ─────────────────────────────────────────────────
exports.handler = async function(event) {
  // Scheduled functions: query params don't work — use POST body {dryrun:true}
  // or call via: curl -X POST https://shoptrack.org/.netlify/functions/trial-drip -d '{"dryrun":true}'
  let bodyObj = {};
  try { bodyObj = JSON.parse(event.body || '{}'); } catch {}
  const isDryRun = bodyObj.dryrun === true
                || event.queryStringParameters?.dryrun === 'true';
  if (isDryRun) console.log('[trial-drip] DRY RUN — emails will NOT be sent');
  const SB_URL   = process.env.SUPABASE_URL;
  const SB_KEY   = process.env.SUPABASE_SERVICE_KEY;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const FROM     = process.env.FROM_EMAIL || 'ShopTrack <noreply@shoptrack.org>';
  const SITE_URL = process.env.SITE_URL   || 'https://shoptrack.org';

  if (!SB_URL || !SB_KEY || !RESEND_KEY) {
    console.error('[trial-drip] Missing env vars');
    return { statusCode: 500, body: 'Missing configuration' };
  }

  const sb = sbClient(SB_URL, SB_KEY);
  const today  = new Date();
  today.setHours(0, 0, 0, 0);

  // Fetch all trial businesses with signup_date and email
  let bizList;
  try {
    bizList = await sb.query('businesses', {
      'select': 'id,name,email,owner,language,signup_date,trial_end,drip_sent,plan',
      'email': 'not.is.null',
      'signup_date': 'not.is.null',
      'order': 'signup_date.desc',
    });
  } catch(err) {
    console.error('[trial-drip] Supabase fetch error:', err.message);
    return { statusCode: 500, body: err.message };
  }

  let sent = 0, skipped = 0;

  for (const biz of (bizList || [])) {
    // Only send to trial businesses (no paid plan yet)
    const plan = (biz.plan || '').toLowerCase();
    // Exclude paid plans — match all naming variants seen in Supabase
    // Trial variants: "Free Trial", "Trial (30 Days)", "trial", "" (empty = still onboarding)
    // Paid variants:  "Starter", "Pro", "Professional", "Enterprise", "Active"
    const isPaidPlan = plan === 'premium' || plan === 'free' || plan === 'starter' || plan === 'pro'
                    || plan === 'professional' || plan === 'enterprise' || plan === 'active';
    if (isPaidPlan) { skipped++; continue; }
    // Only process businesses that explicitly have a trial plan OR empty plan (still in trial)
    // This prevents sending drip to businesses with unexpected plan strings
    const isTrialPlan = !plan || plan.includes('trial') || plan === 'free trial';
    if (!isTrialPlan) { skipped++; continue; }
    if (!biz.email) { skipped++; continue; }

    const signupDate = new Date(biz.signup_date + 'T00:00:00');
    const daysSince  = Math.floor((today - signupDate) / (1000 * 60 * 60 * 24));
    const sentKeys   = (() => { try { return JSON.parse(biz.drip_sent || '[]'); } catch { return []; } })();

    // Find which drip email to send today
    // Find the correct email to send:
    // 1. First check if today's exact-day email is due (normal case)
    // 2. If no exact match, find the most recent overdue email not yet sent (catchup case)
    //    This handles businesses that were added to the system after the cron was deployed
    const dueTodayExact = DRIP_SEQUENCE.find(d => d.day === daysSince && !sentKeys.includes(d.key));
    const pastDueUnsent = DRIP_SEQUENCE
      .filter(d => d.day <= daysSince && !sentKeys.includes(d.key))
      .sort((a, b) => b.day - a.day); // descending — most recent first
    const toSend = dueTodayExact || (pastDueUnsent.length ? pastDueUnsent[0] : null);
    if (!toSend) { skipped++; continue; }

    // Fetch live stats for personalised emails (days 4, 20, 27, 30)
    let stats = null;
    if (['d4_week_report', 'd20_urgency', 'd27_hard_cta', 'd30_expired'].includes(toSend.key)) {
      const [salesData, custsData] = await Promise.all([
        sb.query('sales', { 'select': 'total,amt', 'biz_id': 'eq.'+biz.id }).catch(()=>[]),
        sb.query('customers', { 'select': 'id', 'biz_id': 'eq.'+biz.id }).catch(()=>[]),
      ]);
      const totalRev = (salesData||[]).reduce((a, s) => a + (s.total || s.amt || 0), 0);
      stats = {
        sales:     (salesData||[]).length,
        customers: (custsData||[]).length,
        revenue:   totalRev > 0 ? Math.round(totalRev).toLocaleString() + ' XAF' : '0',
      };
    }

    const lang      = biz.language || 'en';
    const firstName = (biz.owner || biz.name || '').split(' ')[0];
    const subject   = lang === 'fr' ? toSend.subject_fr : toSend.subject_en;
    const html      = buildEmail({ key: toSend.key, firstName, bizName: biz.name, lang, stats, siteUrl: SITE_URL });

    if (!html) { skipped++; continue; }

    try {
      if (isDryRun) {
        console.log(`[trial-drip] DRY RUN would send: ${toSend.key} → ${biz.email} (day ${daysSince}, biz: ${biz.name})`);
      } else {
        await sendEmail(RESEND_KEY, {
          from:    FROM,
          to:      biz.email,
          subject,
          html,
          tags:    [{ name: 'drip_key', value: toSend.key }, { name: 'biz_id', value: biz.id }],
        });

        // Mark as sent in Supabase
        const newSentKeys = [...sentKeys, toSend.key];
        await sb.update('businesses', { id: biz.id }, { drip_sent: JSON.stringify(newSentKeys) });
      }
      console.log(`[trial-drip] ${isDryRun ? 'DRY RUN' : 'Sent'}: ${toSend.key} → ${biz.email} (day ${daysSince})`);
      sent++;
    } catch (err) {
      console.error(`[trial-drip] Failed for ${biz.email}:`, err.message);
    }
  }

  console.log(`[trial-drip] Done — ${isDryRun ? 'DRY RUN ' : ''}sent: ${sent}, skipped: ${skipped}`);
  return { statusCode: 200, body: JSON.stringify({ sent, skipped, dryRun: isDryRun }) };
};
