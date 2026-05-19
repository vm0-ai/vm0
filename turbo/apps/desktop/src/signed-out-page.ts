function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

export function buildSignedOutPageUrl(authStartUrl: string): string {
  const escapedAuthStartUrl = escapeHtml(authStartUrl);
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; navigate-to http: https:;">
    <title>Zero</title>
    <style>
      :root {
        color-scheme: dark;
        background: #19191b;
        color: #f5f5f4;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        background: #19191b;
      }

      main {
        width: min(100% - 48px, 360px);
        display: grid;
        gap: 18px;
        justify-items: center;
        text-align: center;
      }

      .mark {
        width: 48px;
        height: 48px;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 8px;
        display: grid;
        place-items: center;
        background: rgba(255, 255, 255, 0.06);
        font-size: 24px;
        font-weight: 650;
      }

      h1 {
        margin: 0;
        font-size: 24px;
        line-height: 1.2;
        font-weight: 650;
      }

      p {
        margin: 0;
        color: #b7b7ae;
        font-size: 14px;
        line-height: 1.6;
      }

      a {
        min-width: 160px;
        min-height: 40px;
        border-radius: 7px;
        display: inline-grid;
        place-items: center;
        background: #f5f5f4;
        color: #19191b;
        font-size: 14px;
        font-weight: 600;
        text-decoration: none;
      }

      a:focus-visible {
        outline: 2px solid #7dd3fc;
        outline-offset: 4px;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="mark" aria-hidden="true">Z</div>
      <h1>Sign in to Zero</h1>
      <p>Use your browser to sign in securely, then return here automatically.</p>
      <a href="${escapedAuthStartUrl}">Sign in</a>
    </main>
  </body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
