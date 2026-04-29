// Twilio WhatsApp via Content Templates
// Credentials from Netlify environment variables
const TWILIO_SID  = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_WA_FROM || 'whatsapp:+13045033113';

// Template SIDs
const TEMPLATES = {
  payment_reminder: 'HX8b07b304ade92c8d278001a2ed7f5998d',
  sale_alert:       'HXe8714706a1f6c0d3553c01158ebfcff8',
};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { to, template, variables, message } = JSON.parse(event.body);
    if (!to) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing "to" phone number' }) };

    // Normalize phone: strip non-digits, add country code if needed
    let phone = String(to).replace(/\D/g, '');
    if (phone.length === 9 && phone.startsWith('6')) phone = '237' + phone; // Cameroon
    if (phone.length === 10 && !phone.startsWith('1')) phone = '1' + phone; // US

    const toWA = 'whatsapp:+' + phone;
    const auth = Buffer.from(TWILIO_SID + ':' + TWILIO_AUTH).toString('base64');

    // Build request body
    const params = new URLSearchParams();
    params.append('From', TWILIO_FROM);
    params.append('To', toWA);

    if (template && TEMPLATES[template]) {
      // Use approved Content Template
      params.append('ContentSid', TEMPLATES[template]);
      // Content variables as JSON: {"1":"John","2":"Premium","3":"expires...","4":"4900"}
      if (variables && Object.keys(variables).length > 0) {
        params.append('ContentVariables', JSON.stringify(variables));
      }
    } else if (message) {
      // Freeform message (only works within 24hr user-initiated window)
      params.append('Body', message);
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing template or message' }) };
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const data = await resp.json();

    if (data.sid) {
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ success: true, messageId: data.sid, status: data.status }),
      };
    } else {
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ success: false, error: data.message || 'Unknown error', code: data.code }),
      };
    }
  } catch (e) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ success: false, error: e.message }),
    };
  }
};
