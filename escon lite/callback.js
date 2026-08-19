// Cloudflare Pages Function — Truecaller server-to-server callback.
//
// Truecaller's app POSTs to this endpoint (configured as this app's
// "Callback URL" in the Truecaller developer console) in three situations:
//   1. { requestId, status: "flow_invoked" }   — the verification bottom
//      sheet was opened on the visitor's phone. This is just a handshake;
//      we must acknowledge with a 2XX quickly.
//   2. { requestId, accessToken, endpoint }    — the visitor approved
//      verification. We must call `endpoint` with the access token to
//      fetch their profile (name + phone number).
//   3. { requestId, status: "user_rejected" }  — the visitor declined.
//
// Truecaller requires this endpoint to respond within 3 seconds, so the
// profile fetch below is not allowed to hang — if it fails we still store
// an "error" status and return 200 so Truecaller doesn't retry forever.
//
// Results are written to the TRUECALLER_DB D1 database (table:
// `verifications`, keyed by request_id). D1 is used instead of KV
// deliberately: Workers KV's get() can serve a cached value for up to
// ~60 seconds after a write from a different edge location, which made
// the frontend's poller (see status.js) see a stale "pending" result long
// after the real "verified" result had already landed. D1 gives
// read-after-write consistency, so the poller sees results immediately.

const RESULT_TTL_MS = 10 * 60 * 1000; // 10 minutes — plenty for a page visit.

// Same Google Apps Script web app every on-page form (Site Visit, Brochure,
// Price Request, Callback, Call/WhatsApp capture) already posts leads to.
// Reusing it here means a Truecaller verification is captured as a lead
// immediately, server-side — it doesn't depend on the visitor's browser
// still being on the page, still polling, or completing any form.
const GOOGLE_SHEET_WEB_APP_URL =
  'https://script.google.com/macros/s/AKfycbzNC3OJcfzy2rOKHTqT0m3OGmWZ_R_OlMIv0X-ImnHhgk_4OnMsJ3Fzv6cnblgMjrM2-g/exec';

async function captureLead(phone, name) {
  if (!/^[0-9]{10}$/.test(phone || '')) return; // don't log junk/partial numbers
  const leadData = {
    name: name || '(name not shared)',
    phone,
    email: '',
    unitType: '',
    visitDate: '',
    visitTime: '',
    message: 'Auto-captured via the site-wide Truecaller popup (no form filled in).',
    project: 'Escon Primera',
    source: 'Truecaller Auto Popup',
    submittedAt: new Date().toISOString(),
  };
  try {
    await fetch(GOOGLE_SHEET_WEB_APP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(leadData),
    });
  } catch (err) {
    // Best-effort — the verification result is already safely in D1 either way.
  }
}

async function upsert(db, requestId, status, phone, message, name) {
  await db
    .prepare(
      `INSERT INTO verifications (request_id, status, phone, name, message, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(request_id) DO UPDATE SET
         status = excluded.status,
         phone = excluded.phone,
         name = excluded.name,
         message = excluded.message,
         created_at = excluded.created_at`
    )
    .bind(requestId, status, phone || null, name || null, message || null, Date.now())
    .run();
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const db = env.TRUECALLER_DB;
  if (!db) {
    // Binding not configured — nothing we can do but acknowledge so
    // Truecaller doesn't keep retrying.
    return new Response('D1 binding missing', { status: 200 });
  }

  // Housekeeping: opportunistically clear out old rows so this small table
  // doesn't grow forever. Cheap no-op most of the time since there's rarely
  // anything old to delete; not awaited-critical so failures here don't
  // block the actual callback handling below.
  context.waitUntil(
    db.prepare('DELETE FROM verifications WHERE created_at < ?1').bind(Date.now() - RESULT_TTL_MS).run().catch(() => {})
  );

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return new Response('Invalid JSON', { status: 400 });
  }

  const requestId = body && body.requestId;
  if (!requestId) {
    return new Response('Missing requestId', { status: 400 });
  }

  // 1) Handshake — overlay opened on the device. Mark pending so the
  //    frontend's poller knows verification is genuinely in flight.
  if (body.status === 'flow_invoked') {
    await upsert(db, requestId, 'pending');
    return new Response('OK', { status: 200 });
  }

  // 2) User declined verification in the Truecaller overlay.
  if (body.status === 'user_rejected') {
    await upsert(db, requestId, 'rejected');
    return new Response('OK', { status: 200 });
  }

  // 3) Success — short-lived access token + a profile endpoint to fetch.
  if (body.accessToken && body.endpoint) {
    try {
      const profileRes = await fetch(body.endpoint, {
        headers: { Authorization: `Bearer ${body.accessToken}` },
      });

      if (!profileRes.ok) {
        let bodySnippet = '';
        try {
          bodySnippet = (await profileRes.text()).slice(0, 200);
        } catch (readErr) {
          bodySnippet = '(could not read response body)';
        }
        await upsert(
          db,
          requestId,
          'error',
          null,
          `profile_fetch_failed: HTTP ${profileRes.status} ${profileRes.statusText} — ${bodySnippet}`
        );
        return new Response('OK', { status: 200 });
      }

      const profile = await profileRes.json();

      const rawPhone =
        Array.isArray(profile.phoneNumbers) && profile.phoneNumbers.length
          ? String(profile.phoneNumbers[0])
          : '';
      // Truecaller returns numbers without a leading "+"; normalise to
      // a plain 10-digit Indian mobile number to match this site's forms
      // (they store/display numbers without country code).
      const phoneNumber = rawPhone.replace(/^91/, '').replace(/\D/g, '').slice(-10);

      const firstName = (profile.name && profile.name.first) || '';
      const lastName = (profile.name && profile.name.last) || '';
      const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();

      await upsert(db, requestId, 'verified', phoneNumber, null, fullName);
      context.waitUntil(captureLead(phoneNumber, fullName));

      return new Response('OK', { status: 200 });
    } catch (err) {
      await upsert(
        db,
        requestId,
        'error',
        null,
        `exception: ${err && err.message ? err.message : String(err)}`
      );
      return new Response('OK', { status: 200 });
    }
  }

  // Unrecognised payload shape — acknowledge anyway so Truecaller stops retrying.
  await upsert(db, requestId, 'error', null, 'unknown_payload');
  return new Response('OK', { status: 200 });
}
