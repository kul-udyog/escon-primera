// Cloudflare Pages Function — runs before every request.
// Purpose: if a visitor lands on the auto-generated *.pages.dev URL
// (Cloudflare's built-in alias for this Pages project), send them to
// the real domain instead. This only triggers for pages.dev hosts —
// requests to escon-primera.com / www.escon-primera.com pass straight
// through untouched, so there is no redirect-loop risk.

export async function onRequest(context) {
  const url = new URL(context.request.url);

  if (url.hostname.endsWith('.pages.dev')) {
    const target = 'https://escon-primera.com' + url.pathname + url.search;
    return Response.redirect(target, 301);
  }

  return context.next();
}
