// netlify/functions/aff-lookup.js — Rich affiliate stats with per-referral breakdown

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
  if (!SB_URL || !SB_KEY) return { statusCode: 500, headers, body: JSON.stringify([]) };

  const email = ((event.queryStringParameters || {}).email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) return { statusCode: 400, headers, body: JSON.stringify([]) };

  const sbGet = async (path) => {
    try {
      const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
        headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
      });
      return res.ok ? (await res.json().catch(() => [])) : [];
    } catch(e) { return []; }
  };

  try {
    // 1. Fetch affiliate record
    const affRows = await sbGet(`affiliates?email=eq.${encodeURIComponent(email)}&limit=1`);
    if (!affRows || !affRows.length) return { statusCode: 200, headers, body: JSON.stringify([]) };
    const aff = affRows[0];

    // 2. Fetch referred businesses
    let referrals = [];
    if (aff.affiliate_code && !aff.affiliate_code.startsWith('PENDING')) {
      const bizRows = await sbGet(
        `businesses?affiliate_code=eq.${encodeURIComponent(aff.affiliate_code)}&select=id,name,plan,trial_end,sub_expires,affiliate_payments_count,status,created`
      );
      const today = new Date(); today.setHours(0,0,0,0);

      referrals = (bizRows || []).map(b => {
        const trialEnd = b.trial_end ? new Date(b.trial_end + 'T00:00:00') : null;
        const planLow  = (b.plan || '').toLowerCase();
        let refStatus, daysLeft = null;

        if (trialEnd && today <= trialEnd) {
          daysLeft  = Math.ceil((trialEnd - today) / 86400000);
          refStatus = 'trial';
        } else if (['premium','pro','professional','starter','enterprise'].includes(planLow)) {
          refStatus = 'paying';
        } else {
          refStatus = 'free';
        }

        return {
          id:         b.id,
          name:       b.name || 'Business',
          status:     refStatus,
          daysLeft,
          plan:       b.plan || 'Free',
          trialEnd:   b.trial_end || null,
          subExpires: b.sub_expires || null,
          payments:   b.affiliate_payments_count || 0,
          joined:     b.created || null,
          earnedXaf:  0,
          commPayments: 0,
        };
      });
    }

    // 3. Fetch commission rows
    let commissions = [];
    if (aff.id) {
      const commRows = await sbGet(
        `affiliate_commissions?affiliate_id=eq.${encodeURIComponent(aff.id)}&order=created_at.desc&limit=100`
      );
      commissions = (commRows || []).map(c => ({
        biz_id:     c.biz_id,
        payment_num: c.payment_num || 1,
        earned_xaf:  c.earned_xaf || 0,
        amount_xaf:  c.amount_xaf || 0,
        pct:         c.commission_pct || 20,
        paid_out:    c.paid_out || false,
        date:        (c.created_at || '').slice(0, 10),
      }));
    }

    // 4. Attach commission totals to referrals
    const commByBiz = {};
    commissions.forEach(c => {
      if (!commByBiz[c.biz_id]) commByBiz[c.biz_id] = { total: 0, count: 0 };
      commByBiz[c.biz_id].total += c.earned_xaf;
      commByBiz[c.biz_id].count += 1;
    });
    referrals = referrals.map(r => ({
      ...r,
      earnedXaf:    (commByBiz[r.id] || {}).total || 0,
      commPayments: (commByBiz[r.id] || {}).count || 0,
    }));

    const safe = {
      email:            aff.email,
      name:             aff.name || '',
      status:           aff.status,
      affiliate_code:   aff.affiliate_code || null,
      commission_pct:   aff.commission_pct || 20,
      clicks:           aff.clicks || 0,
      conversions:      aff.conversions || 0,
      total_earned_xaf: aff.total_earned_xaf || 0,
      unpaid_xaf:       aff.unpaid_xaf || 0,
      payment_history:  (aff.payment_history || []).slice(0, 10),
      referrals,
      commissions,
    };

    console.log(`[aff-lookup] ${email}: ${referrals.length} referrals, ${commissions.length} commissions`);
    return { statusCode: 200, headers, body: JSON.stringify([safe]) };

  } catch (err) {
    console.error('[aff-lookup] error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify([]) };
  }
};
