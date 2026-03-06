import { NextResponse } from "next/server";
import { env } from "../../../../../src/env";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserIdFromRequest } from "../../../../../src/lib/auth/get-user-id";
import { getOrigin } from "../../../../../src/lib/request/get-origin";

/**
 * Wix Connector Setup Endpoint
 *
 * GET /api/connectors/wix/authorize
 *
 * Wix new apps use client_credentials flow with an instanceId instead
 * of the standard authorization_code redirect flow. This endpoint shows
 * a setup page where the user can:
 *   1. Install the VM0 app on their Wix site (via Wix installer link)
 *   2. Enter their Instance ID to complete the connection
 *
 * The Instance ID is displayed in the Wix Dashboard iFrame
 * (at /api/connectors/wix/dashboard) after the app is installed.
 *
 * On submit, the form navigates to /api/connectors/wix/complete
 * which exchanges the instanceId for tokens and stores the connector.
 */

export async function GET(request: Request) {
  initServices();

  const currentEnv = env();
  const origin = getOrigin(request);

  const userId = await getUserIdFromRequest(request);
  if (!userId) {
    const url = new URL(request.url);
    const loginUrl = new URL("/sign-in", origin);
    loginUrl.searchParams.set(
      "redirect_url",
      new URL(url.pathname + url.search, origin).toString(),
    );
    return NextResponse.redirect(loginUrl.toString());
  }

  const clientId = currentEnv.WIX_OAUTH_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "Wix OAuth not configured" },
      { status: 500 },
    );
  }

  const installerUrl = `https://www.wix.com/installer/install?appId=${encodeURIComponent(clientId)}`;
  const completeUrl = `${origin}/api/connectors/wix/complete`;

  const html = renderSetupPage(installerUrl, completeUrl);
  return new NextResponse(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function renderSetupPage(installerUrl: string, completeUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect Wix</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; margin: 0; background: #fafafa; color: #333;
    }
    .container { text-align: center; padding: 2rem; max-width: 480px; }
    h2 { color: #111; margin-bottom: 0.5rem; }
    .step {
      text-align: left; margin: 1.5rem 0; padding: 1rem;
      background: #fff; border-radius: 8px; border: 1px solid #e5e7eb;
    }
    .step-num {
      display: inline-block; width: 24px; height: 24px; line-height: 24px;
      text-align: center; background: #111; color: #fff; border-radius: 50%;
      font-size: 12px; font-weight: bold; margin-right: 8px;
    }
    .btn {
      display: inline-block; padding: 10px 20px; border-radius: 6px;
      font-size: 14px; font-weight: 500; cursor: pointer;
      text-decoration: none; border: none;
    }
    .btn-primary { background: #111; color: #fff; }
    .btn-primary:hover { background: #333; }
    .btn-secondary { background: #fff; color: #111; border: 1px solid #d1d5db; }
    .btn-secondary:hover { background: #f3f4f6; }
    input[type="text"] {
      width: 100%; padding: 8px 12px; border: 1px solid #d1d5db;
      border-radius: 6px; font-size: 14px; box-sizing: border-box; margin: 8px 0;
    }
    .help { font-size: 12px; color: #6b7280; margin-top: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <h2>Connect Wix</h2>
    <p style="color:#666;">Link your Wix site to VM0</p>

    <div class="step">
      <p><span class="step-num">1</span> <strong>Install the VM0 app on your Wix site</strong></p>
      <p class="help">Click below to open the Wix installer. After installing, come back here.</p>
      <a href="${installerUrl}" target="_blank" rel="noopener" class="btn btn-secondary" style="margin-top:8px;">
        Install on Wix &rarr;
      </a>
    </div>

    <div class="step">
      <p><span class="step-num">2</span> <strong>Enter your Instance ID</strong></p>
      <p class="help">
        After installing, go to your Wix site dashboard &rarr; Manage Apps &rarr;
        VM0 app. The Instance ID is shown in the app panel.
      </p>
      <form action="${completeUrl}" method="GET">
        <input type="text" name="instanceId" id="instanceId"
          placeholder="e.g. 7dd40c41-4c18-44ee-a64c-deb45bd80e34" required>
        <button type="submit" class="btn btn-primary"
          style="width:100%;margin-top:4px;">Connect</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}
