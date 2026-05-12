import { command } from "ccstate";
import { emailUnsubscribeContract } from "@vm0/api-contracts/contracts/email-unsubscribe";

import { env } from "../../lib/env";
import { queryOf } from "../context/request";
import {
  unsubscribeEmailUser$,
  verifyUnsubscribeToken,
} from "../services/email-unsubscribe.service";
import type { RouteEntry } from "../route";

function missingTokenResponse() {
  return { status: 400 as const, body: { error: "Missing token" } };
}

function invalidTokenResponse() {
  return { status: 400 as const, body: { error: "Invalid token" } };
}

function confirmationHtmlResponse(): Response {
  const appUrl = env("VM0_WEB_URL");
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
    <p><a href="${appUrl}/settings">Manage notification preferences</a></p>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

const getEmailUnsubscribe$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const query = get(queryOf(emailUnsubscribeContract.get));
    if (!query.token) {
      return missingTokenResponse();
    }

    const userId = await verifyUnsubscribeToken(query.token);
    signal.throwIfAborted();
    if (!userId) {
      return invalidTokenResponse();
    }

    await set(unsubscribeEmailUser$, userId, signal);
    signal.throwIfAborted();

    return confirmationHtmlResponse();
  },
);

export const emailUnsubscribeRoutes: readonly RouteEntry[] = [
  {
    route: emailUnsubscribeContract.get,
    handler: getEmailUnsubscribe$,
  },
];
