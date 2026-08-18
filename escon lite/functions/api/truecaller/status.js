// Cloudflare Pages Function — polling endpoint.
//
// The frontend calls GET /api/truecaller/status?requestId=... every few
// seconds after triggering Truecaller verification, to find out whether
// Truecaller's async callback (see callback.js) has landed yet.
//
// Reads from the TRUECALLER_DB D1 database (not KV) so that the result is
// visible immediately after callback.js writes it — D1 gives read-after-write
// consistency, unlike Workers KV which can serve a stale cached value for
// up to ~60 seconds after a write from a different edge location.
//
// Response shapes:
//   { status: "pending" }                       — no result yet, keep polling
//   { status: "verified", phone, name }          — visitor verified
//   { status: "rejected" }                       — visitor declined
//   { status: "error", message }                 — something went wrong server-side

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const requestId = url.searchParams.get('requestId');

  const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  if (!requestId) {
    return new Response(JSON.stringify({ status: 'error', message: 'missing requestId' }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  const db = env.TRUECALLER_DB;
  if (!db) {
    return new Response(JSON.stringify({ status: 'error', message: 'db_not_configured' }), {
      status: 200,
      headers: jsonHeaders,
    });
  }

  const row = await db
    .prepare('SELECT status, phone, name, message FROM verifications WHERE request_id = ?1')
    .bind(requestId)
    .first();

  if (!row) {
    // Nothing written yet — either still pending, or the handshake never
    // arrived (e.g. Truecaller app not installed). Frontend treats
    // repeated "pending" as a timeout after its own poll budget.
    return new Response(JSON.stringify({ status: 'pending' }), {
      status: 200,
      headers: jsonHeaders,
    });
  }

  return new Response(
    JSON.stringify({
      status: row.status,
      phone: row.phone || undefined,
      name: row.name || undefined,
      message: row.message || undefined,
    }),
    { status: 200, headers: jsonHeaders }
  );
}
