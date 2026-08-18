// Cloudflare Pages Function — polling endpoint.
//
// The frontend calls GET /api/truecaller/status?requestId=... every few
// seconds after triggering Truecaller verification, to find out whether
// Truecaller's async callback (see callback.js) has landed yet.
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

  const kv = env.TRUECALLER_KV;
  if (!kv) {
    return new Response(JSON.stringify({ status: 'error', message: 'kv_not_configured' }), {
      status: 200,
      headers: jsonHeaders,
    });
  }

  const record = await kv.get(requestId);

  if (!record) {
    // Nothing written yet — either still pending, or the handshake never
    // arrived (e.g. Truecaller app not installed). Frontend treats
    // repeated "pending" as a timeout after its own poll budget.
    return new Response(JSON.stringify({ status: 'pending' }), {
      status: 200,
      headers: jsonHeaders,
    });
  }

  return new Response(record, { status: 200, headers: jsonHeaders });
}
