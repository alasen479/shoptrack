// ─────────────────────────────────────────────────────────────────────────────
// calendar-feed.js — live iCalendar subscription feed for a business
//
// Serves every appointment for one business as a .ics feed that Google
// Calendar, Apple Calendar and Outlook can SUBSCRIBE to (not just import).
// The owner subscribes once; appointments then appear and update on their own.
//
//   GET /.netlify/functions/calendar-feed?t=<calendar_token>
//
// AUTHENTICATION
//   The token IS the credential — a random opaque string stored on the
//   business row (businesses.calendar_token). Calendar apps cannot send
//   headers or sign requests, so a secret in the URL is the only mechanism
//   the protocol allows. Consequences, by design:
//     • Anyone holding the URL can read that business's appointments.
//     • Revocation = generate a new token in the app (old URL dies at once).
//   The token is never derived from the biz id, so it cannot be guessed from
//   one, and lookup is by token only — an attacker enumerating biz ids gets
//   nothing.
//
// TIME ZONES
//   Appointments are stored as wall-clock date + time with no zone. A feed is
//   read on devices anywhere, so wall-clock output would drift. We resolve each
//   appointment to a real UTC instant using the business's IANA zone (per-event,
//   so DST transitions are handled) and emit UTC stamps, which every client
//   renders correctly in its own local time.
//
// REFRESH
//   Google refreshes external feeds on its own schedule (often hours; not
//   configurable). Apple lets the user choose. This feed is therefore a
//   read-only mirror for planning — not a real-time double-booking guard.
// ─────────────────────────────────────────────────────────────────────────────

const PAST_DAYS   = 60;    // keep recent history so the calendar isn't blank
const FUTURE_DAYS = 400;   // a year-plus ahead
const MAX_EVENTS  = 2000;  // hard ceiling — keeps the feed small and fast

// ── Country → IANA time zone ────────────────────────────────────────────────
// Only for countries ShopTrack actually onboards. Anything unknown falls back
// to Africa/Douala (the platform's home market, UTC+1, no DST).
const TZ_BY_COUNTRY = {
  'cameroon':       'Africa/Douala',
  'nigeria':        'Africa/Lagos',
  'ghana':          'Africa/Accra',
  'south africa':   'Africa/Johannesburg',
  'usa':            'America/New_York',
  'united states':  'America/New_York',
  'united kingdom': 'Europe/London',
  'france':         'Europe/Paris',
  'belgium':        'Europe/Brussels',
  'germany':        'Europe/Berlin',
  'europe':         'Europe/Paris',
  'china':          'Asia/Shanghai',
};
const DEFAULT_TZ = 'Africa/Douala';

// ── Supabase REST helper (same shape as campay-billing.js) ──────────────────
async function sbGet(url, key, table, filter) {
  const res = await fetch(`${url}/rest/v1/${table}?${filter}`, {
    headers: {
      'Content-Type':  'application/json',
      'apikey':        key,
      'Authorization': `Bearer ${key}`,
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = []; }
  return { ok: res.ok, status: res.status, data };
}

// ── Time-zone maths ─────────────────────────────────────────────────────────
// Offset (ms) between a zone and UTC at a given instant.
function tzOffsetMs(ts, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(ts))) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return asUTC - ts;
}

// Wall-clock date+time in `tz` → the UTC instant it refers to.
// Two passes because the offset itself depends on the instant (DST edges).
function zonedToUtc(dateStr, timeStr, tz) {
  const [Y, M, D] = String(dateStr).split('-').map(Number);
  const [h, m]    = String(timeStr || '09:00').split(':').map(Number);
  if (!Y || !M || !D) return null;
  const wall = Date.UTC(Y, M - 1, D, h || 0, m || 0, 0);
  let ts = wall;
  for (let i = 0; i < 2; i++) ts = wall - tzOffsetMs(ts, tz);
  return new Date(ts);
}

function utcStamp(d) {
  const p = n => (n < 10 ? '0' + n : '' + n);
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate())
       + 'T' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
}

// ── RFC 5545 text handling ──────────────────────────────────────────────────
function icsEsc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
}

// Fold to 75 OCTETS (not characters) — accents, em-dashes and emoji are
// multi-byte in UTF-8. Iterate by code point so surrogate pairs never split.
function icsFold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts = [];
  let cur = '', curBytes = 0, limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (curBytes + n > limit) { parts.push(cur); cur = ch; curBytes = n; limit = 74; }
    else { cur += ch; curBytes += n; }
  }
  if (cur) parts.push(cur);
  return parts.join('\r\n ');
}

function ymd(d) {
  const p = n => (n < 10 ? '0' + n : '' + n);
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

// ── Handler ─────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const plain = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };

  if (event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD') {
    return { statusCode: 405, headers: plain, body: 'Method not allowed' };
  }

  const q     = event.queryStringParameters || {};
  const token = (q.t || '').trim();

  // Length floor rejects trivially short guesses before any DB round-trip.
  if (!token || token.length < 20) {
    return { statusCode: 401, headers: plain, body: 'Invalid or missing calendar token.' };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[calendar-feed] Supabase env vars missing');
    return { statusCode: 503, headers: plain, body: 'Calendar feed temporarily unavailable.' };
  }

  // ── Resolve the token to exactly one business ──
  let biz;
  try {
    const r = await sbGet(
      SUPABASE_URL, SUPABASE_KEY, 'businesses',
      `calendar_token=eq.${encodeURIComponent(token)}&select=id,name,country,calendar_token&limit=2`
    );
    if (!r.ok) {
      // A missing column reads as a schema error, not a bad token — say so,
      // because otherwise this looks like an auth failure and wastes hours.
      const msg = JSON.stringify(r.data || '');
      if (/calendar_token/i.test(msg) && /column|schema|does not exist/i.test(msg)) {
        console.error('[calendar-feed] businesses.calendar_token column is missing — run the migration.');
        return { statusCode: 503, headers: plain,
          body: 'Calendar feed not configured: the calendar_token column is missing. See CALENDAR-FEED-SETUP.md.' };
      }
      console.error('[calendar-feed] business lookup failed:', r.status, msg.slice(0, 300));
      return { statusCode: 503, headers: plain, body: 'Calendar feed temporarily unavailable.' };
    }
    if (!Array.isArray(r.data) || r.data.length !== 1) {
      console.warn('[calendar-feed] token did not match exactly one business');
      return { statusCode: 401, headers: plain, body: 'Invalid or expired calendar link.' };
    }
    biz = r.data[0];
  } catch (e) {
    console.error('[calendar-feed] lookup error:', e.message);
    return { statusCode: 503, headers: plain, body: 'Calendar feed temporarily unavailable.' };
  }

  const tz = TZ_BY_COUNTRY[String(biz.country || '').trim().toLowerCase()] || DEFAULT_TZ;

  // ── Fetch the appointment window ──
  const now  = new Date();
  const from = ymd(new Date(now.getTime() - PAST_DAYS   * 86400000));
  const to   = ymd(new Date(now.getTime() + FUTURE_DAYS * 86400000));

  let rows = [];
  try {
    const r = await sbGet(
      SUPABASE_URL, SUPABASE_KEY, 'appointments',
      `biz_id=eq.${encodeURIComponent(biz.id)}`
      + `&date=gte.${from}&date=lte.${to}`
      + `&select=id,service_name,customer_name,customer_phone,staff_name,date,start_time,end_time,status,notes`
      + `&order=date.asc&limit=${MAX_EVENTS}`
    );
    if (!r.ok) {
      console.error('[calendar-feed] appointment fetch failed:', r.status);
      return { statusCode: 503, headers: plain, body: 'Calendar feed temporarily unavailable.' };
    }
    rows = Array.isArray(r.data) ? r.data : [];
  } catch (e) {
    console.error('[calendar-feed] appointment fetch error:', e.message);
    return { statusCode: 503, headers: plain, body: 'Calendar feed temporarily unavailable.' };
  }

  // ── Build the calendar ──
  const bizName = biz.name || 'ShopTrack';
  const stamp   = utcStamp(new Date());

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ShopTrack//Appointments Feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:' + icsEsc(bizName + ' — Appointments'),
    'X-WR-CALDESC:' + icsEsc('Live appointment schedule from ShopTrack'),
    'X-WR-TIMEZONE:' + tz,
    // Hints only — clients are free to ignore them, and Google does.
    'REFRESH-INTERVAL;VALUE=DURATION:PT30M',
    'X-PUBLISHED-TTL:PT30M',
  ];

  let emitted = 0, skipped = 0;

  for (const a of rows) {
    const start = zonedToUtc(a.date, a.start_time, tz);
    if (!start || isNaN(start.getTime())) { skipped++; continue; }

    // Missing/'' end time → fall back to a one-hour block.
    let end = a.end_time ? zonedToUtc(a.date, a.end_time, tz) : null;
    if (!end || isNaN(end.getTime()) || end <= start) {
      end = new Date(start.getTime() + 60 * 60000);
    }

    const st = String(a.status || '').toLowerCase();
    // Cancelled/no-show events are still emitted, marked CANCELLED, so that a
    // subscribed calendar removes the slot instead of leaving a stale booking.
    const status = (st === 'cancelled' || st === 'no-show') ? 'CANCELLED'
                 : (st === 'reserved') ? 'TENTATIVE'
                 : 'CONFIRMED';

    const svc     = a.service_name || 'Appointment';
    const cust    = a.customer_name || '';
    const summary = svc + (cust ? ' — ' + cust : '');

    const desc = [];
    desc.push('Service: ' + svc);
    if (cust)            desc.push('Client: ' + cust);
    if (a.customer_phone) desc.push('Phone: ' + a.customer_phone);
    if (a.staff_name)    desc.push('Staff: ' + a.staff_name);
    desc.push('Status: ' + (a.status || 'Reserved'));
    if (a.notes)         desc.push('Notes: ' + a.notes);
    desc.push('—');
    desc.push('Manage this booking in ShopTrack: https://shoptrack.org');

    lines.push(
      'BEGIN:VEVENT',
      // Stable UID: updates replace the event instead of duplicating it.
      'UID:appt-' + (a.id || (a.date + a.start_time)) + '@shoptrack.org',
      'DTSTAMP:' + stamp,
      'DTSTART:' + utcStamp(start),
      'DTEND:'   + utcStamp(end),
      'SUMMARY:' + icsEsc(summary),
      'DESCRIPTION:' + icsEsc(desc.join('\n')),
      'STATUS:' + status,
      // Bumping SEQUENCE on every publish tells clients this copy supersedes
      // whatever they cached, so edits in ShopTrack actually take effect.
      'SEQUENCE:1',
      'TRANSP:' + (status === 'CANCELLED' ? 'TRANSPARENT' : 'OPAQUE'),
      'END:VEVENT'
    );
    emitted++;
  }

  lines.push('END:VCALENDAR');

  if (skipped) console.warn(`[calendar-feed] ${biz.id}: skipped ${skipped} appointment(s) with unusable dates`);
  console.log(`[calendar-feed] ${biz.id} (${bizName}) — ${emitted} events, tz=${tz}`);

  const body = lines.map(icsFold).join('\r\n') + '\r\n';

  return {
    statusCode: 200,
    headers: {
      'Content-Type':  'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="shoptrack-appointments.ics"',
      // Short cache: the feed is cheap, and staleness is already the weak point.
      'Cache-Control': 'public, max-age=300',
      // Feed URLs are credentials — keep them out of referrers and indexes.
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag':    'noindex, nofollow',
    },
    body: event.httpMethod === 'HEAD' ? '' : body,
  };
};
