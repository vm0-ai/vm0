import { command } from "ccstate";
import { webhookAutomationInboundContract } from "@vm0/api-contracts/contracts/webhooks";

import type { RouteEntry } from "../route";
import { request$ } from "../context/hono";
import { pathParamsOf } from "../context/request";
import { now } from "../external/time";
import {
  dispatchAutomationWebhook$,
  SIGNATURE_HEADER,
} from "../services/webhooks-automation.service";

const inboundPathParams$ = pathParamsOf(webhookAutomationInboundContract.post);

function jsonError(message: string, status: 401 | 404 | 429): Response {
  return Response.json({ error: message }, { status });
}

const postAutomationWebhook$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const apiStartTime = now();
    const params = get(inboundPathParams$);
    const request = get(request$);

    const headers = Object.fromEntries(request.raw.headers.entries());
    const rawBody = await request.text();
    signal.throwIfAborted();

    const result = await set(
      dispatchAutomationWebhook$,
      {
        token: params.token,
        signature: request.raw.headers.get(SIGNATURE_HEADER),
        headers,
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
      case "not_found": {
        return jsonError("Not found", 404);
      }
      case "unauthorized": {
        return jsonError("Invalid signature", 401);
      }
      case "rate_limited": {
        return jsonError("Too many requests", 429);
      }
      case "run_error": {
        // The caller authenticated; surface the failure to start the run as a
        // rate-limit-style 429 so retries are throttled rather than hammering.
        return jsonError(result.message, 429);
      }
    }
  },
);

export const webhooksAutomationRoutes: readonly RouteEntry[] = [
  {
    route: webhookAutomationInboundContract.post,
    handler: postAutomationWebhook$,
  },
];
