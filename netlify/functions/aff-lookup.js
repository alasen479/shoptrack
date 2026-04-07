// netlify/functions/aff-lookup.js

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';

  console.log('[aff-lookup] SB_URL:', SB_URL, '| KEY length:', SB_KEY.length);

  if (!SB_URL || !SB_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify([]) };
  }

  const email = ((event.queryStringParameters || {}).email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) {
    return { statusCode: 400, headers, body: JSON.stringify([]) };
  }

  try {
    const endpoint = `${SB_URL}/rest/v1/affiliates?email=eq.${encodeURIComponent(email)}&limit=1`;
    console.log('[aff-lookup] GET:', endpoint);

    const res = await fetch(endpoint, {
      headers: {
        'apikey':        SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`
      }
    });

    console.log('[aff-lookup] Supabase responded:', res.status);
    const data = await res.json().catch(() => []);

    const safe = (Array.isArray(data) ? data : []).map(a => ({
      email:            a.email,
      status:           a.status,
      affiliate_code:   a.affiliate_code || null,
      clicks:           a.clicks || 0,
      conversions:      a.conversions || 0,
      total_earned_xaf: a.total_earned_xaf || 0,
      unpaid_xaf:       a.unpaid_xaf || 0,
      commission_pct:   a.commission_pct || 20
    }));

    return { statusCode: 200, headers, body: JSON.stringify(safe) };

  } catch (err) {
    console.error('[aff-lookup] threw:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify([]) };
  }
};
