import { command } from "ccstate";
import { webhookGmailPubSubContract } from "@vm0/api-contracts/contracts/webhooks";

import type { RouteEntry } from "../route";
import { request$ } from "../context/hono";
import { now } from "../external/time";
import { dispatchGmailPubSubPush$ } from "../services/gmail-event.service";

function jsonError(message: string, status: 400 | 401 | 429 | 503): Response {
  return Response.json({ error: message }, { status });
}

const postGmailWebhook$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const apiStartTime = now();
    const request = get(request$);
    const rawBody = await request.text();
    signal.throwIfAborted();

    const result = await set(
      dispatchGmailPubSubPush$,
      {
        authorization: request.raw.headers.get("authorization"),
        rawBody,
        apiStartTime,
      },
      signal,
    );
    signal.throwIfAborted();

    switch (result.kind) {
      case "ok": {
        return new Response("OK", { status: 200 });
      }
      case "bad_request": {
        return jsonError(result.message, 400);
      }
      case "unauthorized": {
        return jsonError("Invalid Pub/Sub OIDC token", 401);
      }
      case "config_error": {
        return jsonError(result.message, 503);
      }
      case "run_error": {
        return jsonError(result.message, 429);
      }
    }
  },
);

export const webhooksGmailRoutes: readonly RouteEntry[] = [
  {
    route: webhookGmailPubSubContract.post,
    handler: postGmailWebhook$,
  },
];
