// ─────────────────────────────────────────────────────────────────────────────
// issue-token.js — mint a Supabase-compatible JWT scoped to one business
//
// This is the linchpin of ShopTrack's tenant-isolation fix. After the user's
// password is verified HERE (server-side — never trusting the browser's claim
// of who it is), we sign a JWT carrying their biz_id. The frontend attaches
// that JWT to the Supabase client, and RLS policies filter every row by
// `auth.jwt() ->> 'biz_id'`. A leaked anon key alone can then read nothing.
//
//   POST /.netlify/functions/issue-token   { email, password }
//   → 200 { token, biz_id, level, is_super_admin, name, expires_in }
//   → 401 on bad credentials / blocked account
//
// SECURITY MODEL
//   • Credentials are re-verified against platform_users using the SERVICE key
//     (bypasses RLS so the lookup works even after policies are tightened).
//   • The browser cannot influence which biz_id ends up in the token — it comes
//     from the verified DB row, not from the request.
//   • The JWT is signed HS256 with SUPABASE_JWT_SECRET (the "Legacy JWT Secret",
//     which Supabase still uses to VERIFY tokens). Postgres therefore trusts it.
//   • Token lifetime is short (default 12h) so a captured token expires.
//
// REQUIRED ENV VARS (Netlify):
//   SUPABASE_URL           already present
//   SUPABASE_SERVICE_KEY   already present
//   SUPABASE_JWT_SECRET    NEW — paste the Legacy JWT Secret value here
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

const TOKEN_TTL_SECONDS = 12 * 60 * 60; // 12 hours

// ── base64url (JWT-safe) ─────────────────────────────────────────────────────
function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Sign an HS256 JWT with the given secret ──────────────────────────────────
function signJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encHeader  = b64url(JSON.stringify(header));
  const encPayload = b64url(JSON.stringify(payload));
  const data = encHeader + '.' + encPayload;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return data + '.' + sig;
}

// ── Replicate the app's _pwdMatch: plaintext (legacy) OR SHA-256 hex ─────────
function pwdMatch(entered, stored) {
  if (!stored) return false;
  if (stored === entered) return true;                 // legacy plaintext
  const hash = crypto.createHash('sha256').update(entered, 'utf8').digest('hex');
  return stored === hash;                               // SHA-256 hex
}

// ── Supabase REST helper (service key — bypasses RLS for the auth lookup) ─────
async function sbGetUser(url, key, email) {
  const endpoint = `${url}/rest/v1/platform_users`
    + `?email=eq.${encodeURIComponent(email)}`
    + `&select=id,biz_id,level,name,status,email_verified,password_hash,is_super_admin`
    + `&limit=1`;
  const res = await fetch(endpoint, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`user lookup failed: HTTP ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY;
  const JWT_SECRET    = process.env.SUPABASE_JWT_SECRET;
  if (!SUPABASE_URL || !SERVICE_KEY || !JWT_SECRET) {
    console.error('[issue-token] Missing env vars',
      { url: !!SUPABASE_URL, service: !!SERVICE_KEY, jwt: !!JWT_SECRET });
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'Auth service not configured' }) };
  }

  let email, password;
  try {
    const body = JSON.parse(event.body || '{}');
    email    = String(body.email || '').trim().toLowerCase();
    password = String(body.password || '');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }
  if (!email || !password) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email and password required' }) };
  }

  // ── Verify credentials server-side ──
  let user;
  try {
    user = await sbGetUser(SUPABASE_URL, SERVICE_KEY, email);
  } catch (e) {
    console.error('[issue-token] lookup error:', e.message);
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'Auth service temporarily unavailable' }) };
  }

  // Uniform 401 for "no such user" and "wrong password" — never reveal which.
  if (!user || !pwdMatch(password, user.password_hash)) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid email or password' }) };
  }

  // Account-status gate — mirror the app's login rules.
  if (user.status === 'Inactive') {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Account deactivated', code: 'INACTIVE' }) };
  }
  if (user.status === 'Suspended') {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Account suspended', code: 'SUSPENDED' }) };
  }

  // ── Mint the JWT ──
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    // Standard Supabase claims so Postgres treats this as an authenticated role.
    iss:  'shoptrack-issue-token',
    sub:  user.id,                 // becomes auth.uid()
    role: 'authenticated',         // must be a real DB role → RLS applies as authenticated
    aud:  'authenticated',
    iat:  now,
    exp:  now + TOKEN_TTL_SECONDS,
    // Custom claim RLS policies filter on:  auth.jwt() ->> 'biz_id'
    biz_id: user.biz_id || '',
    // Extra claims (handy for policies / debugging; not security-sensitive on their own)
    level: user.level || 'owner',
    is_super_admin: !!user.is_super_admin,
    email,
  };

  let token;
  try {
    token = signJwt(payload, JWT_SECRET);
  } catch (e) {
    console.error('[issue-token] signing failed:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Token generation failed' }) };
  }

  console.log(`[issue-token] issued for ${email} biz=${user.biz_id} level=${user.level}`);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      token,
      biz_id: user.biz_id || '',
      level: user.level || 'owner',
      is_super_admin: !!user.is_super_admin,
      name: user.name || '',
      expires_in: TOKEN_TTL_SECONDS,
    }),
  };
};
