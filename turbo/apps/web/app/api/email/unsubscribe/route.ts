import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { verifyUnsubscribeToken } from "../../../../src/lib/email/handlers/shared";
import { unsubscribeUser } from "../../../../src/lib/email/unsubscribe-service";
import { getPlatformUrl } from "../../../../src/lib/url";

/**
 * Email Unsubscribe Endpoint
 *
 * GET /api/email/unsubscribe?token={token}
 *   User clicks unsubscribe link in email → verifies token → unsubscribes → shows HTML confirmation.
 *
 * POST /api/email/unsubscribe?token={token}
 *   RFC 8058 one-click unsubscribe (Gmail/Yahoo button) → verifies token → unsubscribes → 200 JSON.
 */

function getToken(request: Request): string | null {
  const url = new URL(request.url);
  return url.searchParams.get("token");
}

export async function POST(request: Request): Promise<Response> {
  initServices();

  const token = getToken(request);
  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }

  const userId = verifyUnsubscribeToken(token);
  if (!userId) {
    return NextResponse.json({ error: "Invalid token" }, { status: 400 });
  }

  await unsubscribeUser(userId);

  return NextResponse.json({ unsubscribed: true });
}

export async function GET(request: Request): Promise<Response> {
  initServices();

  const token = getToken(request);
  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }

  const userId = verifyUnsubscribeToken(token);
  if (!userId) {
    return NextResponse.json({ error: "Invalid token" }, { status: 400 });
  }

  await unsubscribeUser(userId);

  const platformUrl = getPlatformUrl();

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Unsubscribed - VM0</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f6f9fc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #fff; padding: 32px; border-radius: 8px; max-width: 480px; text-align: center; }
    h1 { font-size: 20px; color: #111827; margin: 0 0 12px; }
    p { font-size: 14px; color: #6b7280; line-height: 1.6; margin: 0 0 20px; }
    a { color: #2563eb; text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <h1>You have been unsubscribed</h1>
    <p>You will no longer receive system-initiated email notifications from VM0.</p>
    <p><a href="${platformUrl}/settings">Manage notification preferences</a></p>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
