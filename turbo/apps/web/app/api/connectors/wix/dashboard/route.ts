import { NextResponse } from "next/server";
import { getConnectorOAuthConfig } from "@vm0/core";
import { env } from "../../../../../src/env";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserIdFromRequest } from "../../../../../src/lib/auth/get-user-id";
import { resolveScope } from "../../../../../src/lib/scope/resolve-scope";
import { upsertOAuthConnector } from "../../../../../src/lib/connector/connector-service";
import { logger } from "../../../../../src/lib/logger";
import {
  decodeWixInstance,
  exchangeWixCode,
} from "../../../../../src/lib/connector/providers/wix";

const log = logger("api:connectors:wix:dashboard");

/**
 * Wix Dashboard iFrame Endpoint
 *
 * GET /api/connectors/wix/dashboard
 *
 * This endpoint is loaded as an iFrame inside the Wix site dashboard
 * after the app is installed. It receives the `instance` JWT containing
 * the instanceId, which is used to obtain access tokens via
 * client_credentials.
 *
 * Since this runs in an iFrame (cross-origin), auth cookies may not
 * be available. The endpoint returns an HTML page that uses postMessage
 * or redirects to complete the flow.
 */
export async function GET(request: Request) {
  initServices();

  const url = new URL(request.url);
  const instanceParam = url.searchParams.get("instance");

  if (!instanceParam) {
    return htmlResponse(
      "Missing instance parameter. Please try connecting again.",
      true,
    );
  }

  // Decode the instance JWT to get the instanceId
  let instanceId: string;
  try {
    const decoded = decodeWixInstance(instanceParam);
    instanceId = decoded.instanceId;
  } catch {
    return htmlResponse("Invalid instance token.", true);
  }

  // Try to get the authenticated user from cookies.
  // In cross-origin iFrame context, cookies may not be available.
  const userId = await getUserIdFromRequest(request);

  if (!userId) {
    // If no auth cookie (likely due to third-party cookie restrictions),
    // show a page that the user can interact with to complete the flow.
    // Store the instanceId in a pending state for later completion.
    log.info("Wix dashboard loaded without auth - showing manual flow", {
      instanceId,
    });
    return instanceIdPage(instanceId);
  }

  // We have both the instanceId and the userId - complete the flow
  try {
    const currentEnv = env();
    const clientId = currentEnv.WIX_OAUTH_CLIENT_ID;
    const clientSecret = currentEnv.WIX_OAUTH_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return htmlResponse("Wix OAuth is not configured.", true);
    }

    const result = await exchangeWixCode(clientId, clientSecret, instanceId);

    const { scope } = await resolveScope(userId);
    await upsertOAuthConnector(
      scope.id,
      userId,
      "wix",
      result.accessToken,
      {
        id: result.userInfo.id,
        username: result.userInfo.username ?? "",
        email: result.userInfo.email,
      },
      getConnectorOAuthConfig("wix")?.scopes ?? [],
      {
        refreshToken: result.refreshToken,
        refreshSecretName: "WIX_REFRESH_TOKEN",
        expiresIn: result.expiresIn,
      },
    );

    log.info("Wix connector created via dashboard iFrame", {
      userId,
      instanceId,
      username: result.userInfo.username,
    });

    return htmlResponse(
      `
        <h2>Connected!</h2>
        <p>Your Wix account has been connected successfully.</p>
        <p>You can close this window.</p>
      `,
      false,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    log.error("Wix dashboard token exchange failed", {
      error: msg,
      instanceId,
    });
    return htmlResponse(`Connection failed: ${msg}`, true);
  }
}

/**
 * Show the Instance ID prominently so the user can copy it
 * and paste it into the VM0 connection setup page.
 */
function instanceIdPage(instanceId: string): NextResponse {
  // Sanitize instanceId: only allow UUID-like characters
  const safeId = instanceId.replace(/[^a-zA-Z0-9-]/g, "");
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VM0 - Wix App</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; margin: 0; background: #fafafa; color: #333;
    }
    .container { text-align: center; padding: 2rem; max-width: 440px; }
    h2 { color: #16a34a; margin-bottom: 0.5rem; }
    .id-box {
      display: flex; align-items: center; gap: 8px;
      margin: 1rem 0; padding: 10px 14px;
      background: #fff; border: 1px solid #d1d5db; border-radius: 8px;
      font-family: monospace; font-size: 13px; word-break: break-all;
    }
    .id-box code { flex: 1; text-align: left; }
    .copy-btn {
      padding: 6px 12px; border: 1px solid #d1d5db; border-radius: 4px;
      background: #fff; cursor: pointer; font-size: 12px; white-space: nowrap;
    }
    .copy-btn:hover { background: #f3f4f6; }
    .help { font-size: 13px; color: #6b7280; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="container">
    <h2>App Installed!</h2>
    <p>Copy the Instance ID below and paste it into the VM0 connection page.</p>
    <div class="id-box">
      <code id="iid">${safeId}</code>
      <button class="copy-btn" id="copyBtn">Copy</button>
    </div>
    <p class="help">
      Go to VM0 Settings &rarr; Connections &rarr; Connect Wix, then paste this ID in step 2.
    </p>
  </div>
  <script>
    document.getElementById('copyBtn').addEventListener('click', function() {
      var id = document.getElementById('iid').textContent;
      navigator.clipboard.writeText(id).then(function() {
        document.getElementById('copyBtn').textContent = 'Copied!';
      });
    });
  </script>
</body>
</html>`;

  return new NextResponse(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function htmlResponse(body: string, isError: boolean): NextResponse {
  const color = isError ? "#dc2626" : "#16a34a";
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Wix Connection</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #fafafa;
      color: #333;
    }
    .container {
      text-align: center;
      padding: 2rem;
      max-width: 400px;
    }
    h2 { color: ${color}; }
    p { line-height: 1.5; }
  </style>
</head>
<body>
  <div class="container">${body}</div>
</body>
</html>`;

  return new NextResponse(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
