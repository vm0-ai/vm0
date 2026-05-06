// Old documentation lived at docs.vm0.ai and was retired. The Vercel domain
// for docs.vm0.ai now redirects to www.vm0.ai/docs/*, so anything Google still
// has indexed (Quick Start, tutorials, integrations, etc.) lands on this app.
// Returning 410 Gone — instead of letting it 404 — tells search engines the
// pages are permanently removed and triggers faster de-indexing.

const HTML_BODY = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Page removed | VM0</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 480px; margin: 10vh auto; padding: 0 24px; color: #1a1a1a; }
  h1 { font-size: 24px; margin: 0 0 12px; }
  p { line-height: 1.6; color: #555; }
  a { color: #0066cc; }
</style>
</head>
<body>
<h1>This page has been removed</h1>
<p>The VM0 documentation has been retired. Visit the <a href="/">homepage</a> for current resources.</p>
</body>
</html>`;

const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "X-Robots-Tag": "noindex",
  "Cache-Control": "public, max-age=3600",
};

export function GET(): Response {
  return new Response(HTML_BODY, { status: 410, headers: HEADERS });
}

export function HEAD(): Response {
  return new Response(null, { status: 410, headers: HEADERS });
}
