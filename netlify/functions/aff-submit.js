// netlify/functions/aff-submit.js
// Handles affiliate application: inserts to Supabase + sends confirmation email
// Tries Resend first (with verified sender fallback), then Brevo.

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod === 'GET' || !event.body || event.body.trim() === '' || event.body.trim() === '{}') {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, status: 'ready' }) };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: '{}' };

  const SB_URL     = (process.env.SUPABASE_URL || 'https://kjuxnigeexoynmvdzeyl.supabase.co').replace(/\/$/, '');
  const SB_KEY     = process.env.SUPABASE_SERVICE_KEY || '';
  const RESEND_KEY = process.env.RESEND_API_KEY || '';
  const BREVO_KEY  = process.env.BREVO_API_KEY || '';

  // ── Sender address: use env var if set, otherwise Resend's built-in sandbox ─
  // onboarding@resend.dev works on ALL Resend accounts without domain verification
  const FROM_EMAIL = process.env.FROM_EMAIL || '';
  const RESEND_FROM = FROM_EMAIL || 'onboarding@resend.dev';
  const BREVO_FROM  = 'support@shoptrack.work';  // verified Brevo sender

  if (!SB_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'SUPABASE_SERVICE_KEY not set' }) };

  // ── Parse body ─────────────────────────────────────────────────────────────
  let payload;
  try { payload = JSON.parse(event.body); } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  console.log('[aff-submit] keys:', Object.keys(payload).join(', '));

  const { name, email, social_handle } = payload;

  if (!name && !email) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, status: 'no-data' }) };
  }
  if (!name || !email || !email.includes('@')) {
    console.error('[aff-submit] validation fail — name:', name, '| email:', email);
    return { statusCode: 422, headers, body: JSON.stringify({ error: 'name and email required' }) };
  }

  const firstName = name.trim().split(' ')[0];
  const isFr      = (social_handle || '').includes('[lang:fr]');

  // ── DB insert helper ───────────────────────────────────────────────────────
  async function sbInsert(record) {
    const r = await fetch(`${SB_URL}/rest/v1/affiliates`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Prefer':        'return=minimal'
      },
      body: JSON.stringify(record)
    });
    const text = await r.text();
    let body = {};
    try { body = JSON.parse(text); } catch (_) {}
    return { status: r.status, ok: r.ok || r.status === 201, body, text };
  }

  // ── 1. Try full record ─────────────────────────────────────────────────────
  let result;
  try {
    result = await sbInsert({
      name:             name.trim().slice(0, 200),
      email:            email.toLowerCase().trim().slice(0, 200),
      affiliate_code:   'PENDING-' + Date.now(),
      social_handle:    (social_handle || '').slice(0, 500),
      status:           'pending',
      clicks:           0,
      conversions:      0,
      total_earned_xaf: 0,
      unpaid_xaf:       0,
      commission_pct:   20,
      created_at:       new Date().toISOString()
    });
    console.log('[aff-submit] full insert →', result.status);
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }

  // ── 2. Schema mismatch fallback ────────────────────────────────────────────
  if (result.status === 400) {
    console.warn('[aff-submit] schema mismatch, retrying minimal:', result.text.slice(0, 300));
    try {
      result = await sbInsert({
        name:           name.trim().slice(0, 200),
        email:          email.toLowerCase().trim().slice(0, 200),
        affiliate_code: 'PENDING-' + Date.now(),
        social_handle:  (social_handle || '').slice(0, 500),
        status:         'pending'
      });
      console.log('[aff-submit] minimal insert →', result.status);
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── 3. Handle DB errors ────────────────────────────────────────────────────
  if (!result.ok) {
    console.error('[aff-submit] DB error:', result.status, result.text.slice(0, 300));
    if (result.status === 409 || (result.text || '').includes('duplicate') || result.body.code === '23505') {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'duplicate' }) };
    }
    return { statusCode: 502, headers, body: JSON.stringify({
      error: 'Database error', status: result.status,
      code: result.body.code || '', message: result.body.message || result.text.slice(0, 200)
    })};
  }

  console.log('[aff-submit] DB success for', email);

  // ── 4. Email content ───────────────────────────────────────────────────────
  const subject = isFr
    ? "Candidature affilié ShopTrack reçue ✓"
    : 'ShopTrack affiliate application received ✓';

  const html = isFr ? `
<div style="font-family:'Plus Jakarta Sans',Arial,sans-serif;max-width:540px;margin:0 auto;background:#0d0f17;color:#d8deee;border-radius:16px;overflow:hidden;border:1px solid #1e2236">
  <div style="background:linear-gradient(135deg,#6b8fff,#a78bfa);padding:36px 28px;text-align:center">
    <div style="font-size:36px;margin-bottom:10px">&#127968;</div>
    <div style="font-size:24px;font-weight:900;color:#fff;letter-spacing:-.5px">ShopTrack</div>
    <div style="font-size:13px;color:rgba(255,255,255,.75);margin-top:6px">Programme d'affiliation</div>
  </div>
  <div style="padding:36px 28px">
    <p style="font-size:17px;font-weight:800;color:#eef1ff;margin-bottom:10px">Bonjour ${firstName} !</p>
    <p style="color:#8e97ba;line-height:1.8;margin-bottom:24px;font-size:14px">
      Nous avons bien recu votre candidature au programme d'affiliation ShopTrack.<br/>
      Notre equipe l'examinera et vous enverra votre code unique dans les <strong style="color:#eef1ff">48 heures</strong>.
    </p>
    <div style="background:#13151f;border:1px solid #2a2e45;border-radius:10px;padding:18px 22px;margin-bottom:24px">
      <div style="font-size:10px;color:#4a5070;text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px;font-weight:700">Recapitulatif</div>
      <div style="color:#c7d2fe;margin-bottom:6px;font-size:13px"><span style="color:#4a5070">Nom :</span>&nbsp; <strong style="color:#eef1ff">${name}</strong></div>
      <div style="color:#c7d2fe;margin-bottom:6px;font-size:13px"><span style="color:#4a5070">E-mail :</span>&nbsp; <strong style="color:#eef1ff">${email}</strong></div>
      <div style="color:#c7d2fe;font-size:13px"><span style="color:#4a5070">Statut :</span>&nbsp; <span style="color:#f5c842;font-weight:700">En attente d'approbation</span></div>
    </div>
    <div style="background:#0f1623;border:1px solid #1e2236;border-radius:10px;padding:18px 22px;margin-bottom:24px">
      <div style="font-size:10px;color:#4a5070;text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px;font-weight:700">Ce qui se passe ensuite</div>
      <div style="color:#8e97ba;font-size:13px;line-height:2">
        &#10003;&nbsp; Notre equipe examine votre profil<br/>
        &#10003;&nbsp; Vous recevez votre code unique par e-mail<br/>
        &#10003;&nbsp; Partagez votre lien et gagnez des commissions
      </div>
    </div>
    <div style="background:#0a0f1f;border:1px solid #1a2040;border-radius:8px;padding:14px 18px;text-align:center">
      <div style="font-size:11px;color:#4a5070;margin-bottom:6px">Votre futur lien</div>
      <code style="color:#6b8fff;font-size:13px">shoptrack.org/?aff=VOTRECODE</code>
    </div>
  </div>
  <div style="padding:20px 28px;border-top:1px solid #1e2236;text-align:center;font-size:11px;color:#4a5070">
    &copy; 2026 ShopTrack &middot; <a href="mailto:info@shoptrack.work" style="color:#6b8fff;text-decoration:none">info@shoptrack.work</a>
  </div>
</div>` : `
<div style="font-family:'Plus Jakarta Sans',Arial,sans-serif;max-width:540px;margin:0 auto;background:#0d0f17;color:#d8deee;border-radius:16px;overflow:hidden;border:1px solid #1e2236">
  <div style="background:linear-gradient(135deg,#6b8fff,#a78bfa);padding:36px 28px;text-align:center">
    <div style="font-size:36px;margin-bottom:10px">&#127968;</div>
    <div style="font-size:24px;font-weight:900;color:#fff;letter-spacing:-.5px">ShopTrack</div>
    <div style="font-size:13px;color:rgba(255,255,255,.75);margin-top:6px">Affiliate Program</div>
  </div>
  <div style="padding:36px 28px">
    <p style="font-size:17px;font-weight:800;color:#eef1ff;margin-bottom:10px">Hey ${firstName}!</p>
    <p style="color:#8e97ba;line-height:1.8;margin-bottom:24px;font-size:14px">
      We've received your ShopTrack affiliate application.<br/>
      Our team will review it and send you your unique affiliate code within <strong style="color:#eef1ff">48 hours</strong>.
    </p>
    <div style="background:#13151f;border:1px solid #2a2e45;border-radius:10px;padding:18px 22px;margin-bottom:24px">
      <div style="font-size:10px;color:#4a5070;text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px;font-weight:700">Your application</div>
      <div style="color:#c7d2fe;margin-bottom:6px;font-size:13px"><span style="color:#4a5070">Name:</span>&nbsp; <strong style="color:#eef1ff">${name}</strong></div>
      <div style="color:#c7d2fe;margin-bottom:6px;font-size:13px"><span style="color:#4a5070">Email:</span>&nbsp; <strong style="color:#eef1ff">${email}</strong></div>
      <div style="color:#c7d2fe;font-size:13px"><span style="color:#4a5070">Status:</span>&nbsp; <span style="color:#f5c842;font-weight:700">Pending review</span></div>
    </div>
    <div style="background:#0f1623;border:1px solid #1e2236;border-radius:10px;padding:18px 22px;margin-bottom:24px">
      <div style="font-size:10px;color:#4a5070;text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px;font-weight:700">What happens next</div>
      <div style="color:#8e97ba;font-size:13px;line-height:2">
        &#10003;&nbsp; Our team reviews your profile<br/>
        &#10003;&nbsp; You receive your unique code by email<br/>
        &#10003;&nbsp; Share your link and start earning
      </div>
    </div>
    <div style="background:#0a0f1f;border:1px solid #1a2040;border-radius:8px;padding:14px 18px;text-align:center">
      <div style="font-size:11px;color:#4a5070;margin-bottom:6px">Your future affiliate link</div>
      <code style="color:#6b8fff;font-size:13px">shoptrack.org/?aff=YOURCODE</code>
    </div>
  </div>
  <div style="padding:20px 28px;border-top:1px solid #1e2236;text-align:center;font-size:11px;color:#4a5070">
    &copy; 2026 ShopTrack &middot; <a href="mailto:info@shoptrack.work" style="color:#6b8fff;text-decoration:none">info@shoptrack.work</a>
  </div>
</div>`;

  // ── 5. Send via Brevo (primary — verified sender) ──────────────────────────────────────────────────────
  if (BREVO_KEY) {
    try {
      const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': BREVO_KEY },
        body: JSON.stringify({
          sender:      { name: 'ShopTrack', email: BREVO_FROM },
          to:          [{ email }],
          subject,
          htmlContent: html
        })
      });
      const rb = await r.json().catch(() => ({}));
      console.log('[aff-submit] Brevo →', r.status, rb.messageId || JSON.stringify(rb).slice(0,120));
      if (r.ok && rb.messageId) {
        emailSent = true;
        console.log('[aff-submit] email sent via Brevo');
      } else {
        console.warn('[aff-submit] Brevo failed:', r.status, JSON.stringify(rb).slice(0,200));
      }
    } catch (e) {
      console.warn('[aff-submit] Brevo exception:', e.message);
    }
  }

  // ── 6. Resend fallback (tries configured FROM first, then sandbox fallback) ─
  let emailSent = false;

  if (RESEND_KEY) {
    // Attempt 1: use configured FROM_EMAIL
    const senderOptions = RESEND_FROM !== 'onboarding@resend.dev'
      ? [RESEND_FROM, 'onboarding@resend.dev']   // try real address first, sandbox second
      : ['onboarding@resend.dev'];                // no FROM_EMAIL set — go straight to sandbox

    for (const fromAddr of senderOptions) {
      if (emailSent) break;
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}` },
          body: JSON.stringify({
            from:    `ShopTrack <${fromAddr}>`,
            to:      [email],
            subject,
            html
          })
        });
        const rb = await r.json().catch(() => ({}));
        console.log('[aff-submit] Resend from=' + fromAddr + ' →', r.status, rb.id || JSON.stringify(rb).slice(0,120));
        if (r.ok && rb.id) {
          emailSent = true;
          console.log('[aff-submit] email sent via Resend from:', fromAddr);
        } else if (rb.statusCode === 422 || (rb.message || '').includes('from')) {
          console.warn('[aff-submit] Resend from address rejected, trying next...');
        } else {
          console.warn('[aff-submit] Resend error:', r.status, JSON.stringify(rb).slice(0,200));
          break; // non-address error, don't retry with different sender
        }
      } catch (e) {
        console.warn('[aff-submit] Resend exception:', e.message);
      }
    }
  }

  if (!emailSent) {
    console.warn('[aff-submit] No email sent. RESEND_KEY set:', !!RESEND_KEY, '| BREVO_KEY set:', !!BREVO_KEY, '| FROM_EMAIL:', FROM_EMAIL || '(not set — using sandbox)');
  }

  return { statusCode: 201, headers, body: JSON.stringify({ ok: true, emailSent }) };
};
