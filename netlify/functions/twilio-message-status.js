// netlify/functions/twilio-message-status.js
// Fetch the current delivery status of a previously-sent Twilio WhatsApp
// message. Used by the SA Message Log page to show whether a broadcast or
// reminder was actually delivered.
//
// Gated behind the same SA_FN_SECRET shared secret as sa-billing-reminder.
// Without that gate, anyone with a guessed messageId could poll status.
//
// Env vars required:
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   SA_FN_SECRET
//
// Body: { secret: "...", messageId: "SMxxxxxx" }
// Response: { success: true, status, error_code, error_message, date_sent, date_updated, to }
//   status values: queued | sent | delivered | read | undelivered | failed

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Invalid JSON' }) }; }

  const SECRET = process.env.SA_FN_SECRET || '';
  if (!SECRET || SECRET.length < 16) {
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'Function not configured' }) };
  }
  if ((body.secret || '') !== SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: 'Unauthorized' }) };
  }

  const messageId = (body.messageId || '').toString().trim();
  if (!messageId || !messageId.startsWith('SM') && !messageId.startsWith('MM')) {
    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Valid Twilio messageId required' }) };
  }

  const SID  = process.env.TWILIO_ACCOUNT_SID || '';
  const AUTH = process.env.TWILIO_AUTH_TOKEN  || '';
  if (!SID || !AUTH) {
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: 'Twilio credentials not set' }) };
  }

  try {
    const url  = `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages/${messageId}.json`;
    const auth = Buffer.from(SID + ':' + AUTH).toString('base64');
    const resp = await fetch(url, { headers: { 'Authorization': 'Basic ' + auth } });
    const data = await resp.json();

    if (!resp.ok) {
      return { statusCode: resp.status, headers, body: JSON.stringify({
        success: false,
        error: (data && data.message) || 'Twilio lookup failed',
        code:  data && data.code
      }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({
      success: true,
      status:        data.status,
      error_code:    data.error_code,
      error_message: data.error_message,
      date_sent:     data.date_sent,
      date_updated:  data.date_updated,
      to:            data.to,
    }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: e.message || 'Network error' }) };
  }
};
