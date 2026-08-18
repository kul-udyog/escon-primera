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
// Results are written to the TRUECALLER_KV namespace keyed by requestId,
// with a short TTL. The frontend polls /api/truecaller/status?requestId=...
// (see status.js) to pick up the result.

const RESULT_TTL_SECONDS = 600; // 10 minutes — plenty for a page visit.

export async function onRequestPost(context) {
  const { request, env } = context;

  const kv = env.TRUECALLER_KV;
  if (!kv) {
    // Binding not configured — nothing we can do but acknowledge so
    // Truecaller doesn't keep retrying.
    return new Response('KV binding missing', { status: 200 });
  }

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
    await kv.put(requestId, JSON.stringify({ status: 'pending' }), {
      expirationTtl: RESULT_TTL_SECONDS,
    });
    return new Response('OK', { status: 200 });
  }

  // 2) User declined verification in the Truecaller overlay.
  if (body.status === 'user_rejected') {
    await kv.put(requestId, JSON.stringify({ status: 'rejected' }), {
      expirationTtl: RESULT_TTL_SECONDS,
    });
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
        await kv.put(
          requestId,
          JSON.stringify({
            status: 'error',
            message: `profile_fetch_failed: HTTP ${profileRes.status} ${profileRes.statusText} — ${bodySnippet}`,
          }),
          { expirationTtl: RESULT_TTL_SECONDS }
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

      await kv.put(
        requestId,
        JSON.stringify({ status: 'verified', phone: phoneNumber, name: fullName }),
        { expirationTtl: RESULT_TTL_SECONDS }
      );

      return new Response('OK', { status: 200 });
    } catch (err) {
      await kv.put(
        requestId,
        JSON.stringify({ status: 'error', message: `exception: ${err && err.message ? err.message : String(err)}` }),
        { expirationTtl: RESULT_TTL_SECONDS }
      );
      return new Response('OK', { status: 200 });
    }
  }

  // Unrecognised payload shape — acknowledge anyway so Truecaller stops retrying.
  await kv.put(
    requestId,
    JSON.stringify({ status: 'error', message: 'unknown_payload' }),
    { expirationTtl: RESULT_TTL_SECONDS }
  );
  return new Response('OK', { status: 200 });
}
