import { NextResponse } from "next/server";

/**
 * GET /api/integrations/telegram/auth-callback
 *
 * Telegram Login Widget redirect target. Returns a minimal HTML page that
 * sends the auth data back to the opener window via postMessage and closes
 * the popup.
 *
 * Auth data may arrive as query params OR as a hash fragment (which the
 * server cannot see), so the page handles both client-side.
 */
export async function GET() {
  const html = `<!DOCTYPE html>
<html><head><title>Telegram Auth</title></head>
<body><script>
(function() {
  var params = new URLSearchParams(window.location.search);
  if (!params.get("id")) {
    params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  }
  var targetOrigin =
    new URLSearchParams(window.location.search).get("targetOrigin") ||
    window.location.origin;
  var data = {};
  ["id","first_name","last_name","username","photo_url","auth_date","hash"].forEach(function(k) {
    var v = params.get(k);
    if (v !== null) data[k] = v;
  });
  if (window.opener && data.id) {
    window.opener.postMessage(
      { type: "telegram-auth", data: data },
      targetOrigin
    );
  }
  window.close();
})();
</script></body></html>`;

  return new NextResponse(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
