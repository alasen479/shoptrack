// netlify/functions/aff-click.js
// Increments click count for an affiliate code
// Called from bootApp() when ?aff=CODE is detected in the URL

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: '{}' };

  const SB_URL = (process.env.SUPABASE_URL || 'https://kjuxnigeexoynmvdzeyl.supabase.co').replace(/\/$/, '');
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
  if (!SB_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Not configured' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const code = (body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 30);
  if (!code || code.length < 3) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid code' }) };
  }

  try {
    // Fetch current clicks
    const getRes = await fetch(
      `${SB_URL}/rest/v1/affiliates?affiliate_code=eq.${encodeURIComponent(code)}&status=eq.approved&select=id,clicks`,
      { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } }
    );
    const rows = await getRes.json().catch(() => []);
    if (!rows || !rows.length) {
      return { statusCode: 404, headers, body: JSON.stringify({ ok: false, reason: 'code_not_found' }) };
    }
    const aff = rows[0];
    const newClicks = (aff.clicks || 0) + 1;

    // Increment clicks
    const patchRes = await fetch(
      `${SB_URL}/rest/v1/affiliates?id=eq.${encodeURIComponent(aff.id)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`,
          'Content-Type': 'application/json', 'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ clicks: newClicks })
      }
    );

    if (patchRes.status === 204 || patchRes.ok) {
      console.log(`[aff-click] ${code} → clicks: ${newClicks}`);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, clicks: newClicks }) };
    }
    return { statusCode: 502, headers, body: JSON.stringify({ ok: false }) };

  } catch (err) {
    console.error('[aff-click] error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
