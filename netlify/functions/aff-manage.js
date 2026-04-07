// netlify/functions/aff-manage.js
// Server-side affiliate management using service role key (bypasses RLS).
// Actions: approve, suspend, reactivate, mark-paid, partial-pay, set-code, add, delete

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: '{}' };

  const SB_URL = (process.env.SUPABASE_URL || 'https://kjuxnigeexoynmvdzeyl.supabase.co').replace(/\/$/, '');
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
  if (!SB_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'SUPABASE_SERVICE_KEY not set' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { action, id, record } = body;
  if (!action || !id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'action and id required' }) };

  // ── Handle each action ──────────────────────────────────────────────────────
  let patch = {};

  if (action === 'approve')     patch = { status: 'approved' };
  else if (action === 'suspend')    patch = { status: 'suspended' };
  else if (action === 'reactivate') patch = { status: 'approved' };
  else if (action === 'mark-paid') {
    // Fetch current state to log payment in history
    try {
      const fetchRes = await fetch(`${SB_URL}/rest/v1/affiliates?id=eq.${encodeURIComponent(id)}&select=unpaid_xaf,payment_history`, {
        headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
      });
      const rows = await fetchRes.json().catch(() => []);
      if (rows && rows[0]) {
        const existing = Array.isArray(rows[0].payment_history) ? rows[0].payment_history : [];
        const amount = rows[0].unpaid_xaf || 0;
        const entry = { amount, method: 'Mark Paid (SA)', reference: '', notes: 'Full balance cleared', paid_at: new Date().toISOString(), paid_by: 'SA' };
        patch = { unpaid_xaf: 0, payment_history: [entry, ...existing] };
      } else { patch = { unpaid_xaf: 0 }; }
    } catch (_e) { patch = { unpaid_xaf: 0 }; }
  }

  else if (action === 'partial-pay') {
    // Partial or full payment — record is { amount, new_unpaid, method, reference, notes, paid_at, paid_by }
    if (!record || record.amount == null) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'amount required' }) };
    }

    const newUnpaid = Math.max(0, Math.round(record.new_unpaid || 0));

    // Build payment history entry
    const paymentEntry = {
      amount:    Math.round(record.amount),
      method:    record.method    || 'Mobile Money',
      reference: record.reference || '',
      notes:     record.notes     || '',
      paid_at:   record.paid_at   || new Date().toISOString(),
      paid_by:   record.paid_by   || 'SA'
    };

    // First fetch current affiliate to get existing payment_history
    const fetchRes = await fetch(`${SB_URL}/rest/v1/affiliates?id=eq.${encodeURIComponent(id)}&select=payment_history,unpaid_xaf`, {
      headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
    });
    let existingHistory = [];
    if (fetchRes.ok) {
      const rows = await fetchRes.json().catch(() => []);
      if (rows && rows[0] && Array.isArray(rows[0].payment_history)) {
        existingHistory = rows[0].payment_history;
      }
    }

    // Prepend new payment to history
    const updatedHistory = [paymentEntry, ...existingHistory];

    patch = {
      unpaid_xaf:      newUnpaid,
      payment_history: updatedHistory
    };

    console.log(`[aff-manage] partial-pay ${id}: -${record.amount} XAF → remaining ${newUnpaid} XAF via ${record.method}`);

  } else if (action === 'set-code') {
    if (!record || !record.affiliate_code) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'affiliate_code required' }) };
    }
    patch = { affiliate_code: String(record.affiliate_code).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,30) };

  } else if (action === 'add') {
    if (!record) return { statusCode: 400, headers, body: JSON.stringify({ error: 'record required' }) };
    // Ensure payment_history is initialized
    record.payment_history = record.payment_history || [];
    const insertRes = await sbFetch(`${SB_URL}/rest/v1/affiliates`, SB_KEY, 'POST', record);
    if (insertRes.status === 201) return { statusCode: 201, headers, body: JSON.stringify({ ok: true }) };
    const err = await insertRes.json().catch(() => ({}));
    if (insertRes.status === 409 || err.code === '23505') {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'duplicate' }) };
    }
    return { statusCode: 502, headers, body: JSON.stringify({ error: err.message || 'Insert failed' }) };

  } else if (action === 'delete') {
    const delRes = await fetch(`${SB_URL}/rest/v1/affiliates?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Prefer': 'return=minimal' }
    });
    if (delRes.ok || delRes.status === 204 || delRes.status === 200) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }
    const delErr = await delRes.json().catch(() => ({}));
    return { statusCode: 502, headers, body: JSON.stringify({ error: delErr.message || 'Delete failed' }) };

  } else {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action: ' + action }) };
  }

  // ── PATCH update ────────────────────────────────────────────────────────────
  const url = `${SB_URL}/rest/v1/affiliates?id=eq.${encodeURIComponent(id)}`;
  console.log(`[aff-manage] ${action} → PATCH`, url, patch);

  const res = await sbFetch(url, SB_KEY, 'PATCH', patch);
  console.log('[aff-manage] response:', res.status);

  if (res.status === 204 || res.ok) return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };

  const errBody = await res.json().catch(() => ({}));
  console.error('[aff-manage] error:', res.status, errBody);
  return { statusCode: 502, headers, body: JSON.stringify({ error: errBody.message || 'Update failed', code: errBody.code }) };
};

async function sbFetch(url, key, method, body) {
  return fetch(url, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        key,
      'Authorization': `Bearer ${key}`,
      'Prefer':        'return=minimal'
    },
    body: body ? JSON.stringify(body) : undefined
  });
}
