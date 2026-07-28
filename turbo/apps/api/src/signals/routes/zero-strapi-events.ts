import { Buffer } from "node:buffer";

import { zeroStrapiEventsContract } from "@vm0/api-contracts/contracts/zero-strapi-integrations";
import { command } from "ccstate";

import { request$ } from "../context/hono";
import { pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  dispatchStrapiWebhook$,
  STRAPI_WEBHOOK_BODY_LIMIT_BYTES,
} from "../services/strapi-workflow-event.service";

function errorResponse(message: string, status: 400 | 401 | 403 | 404 | 413) {
  const code = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    413: "PAYLOAD_TOO_LARGE",
  }[status];
  return Response.json({ error: { message, code } }, { status });
}

const post$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const params = get(pathParamsOf(zeroStrapiEventsContract.post));
    const request = get(request$);
    const contentLength = Number.parseInt(
      request.raw.headers.get("content-length") ?? "0",
      10,
    );
    if (
      Number.isFinite(contentLength) &&
      contentLength > STRAPI_WEBHOOK_BODY_LIMIT_BYTES
    ) {
      return errorResponse("Payload too large", 413);
    }
    const rawBody = await request.text();
    signal.throwIfAborted();
    if (Buffer.byteLength(rawBody, "utf8") > STRAPI_WEBHOOK_BODY_LIMIT_BYTES) {
      return errorResponse("Payload too large", 413);
    }
    const result = await set(
      dispatchStrapiWebhook$,
      {
        integrationId: params.integrationId,
        authorization: request.raw.headers.get("authorization"),
        eventHeader: request.raw.headers.get("x-strapi-event"),
        rawBody,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind === "not_found") {
      return errorResponse("Not found", 404);
    }
    if (result.kind === "unauthorized") {
      return errorResponse("Unauthorized", 401);
    }
    if (result.kind === "disabled") {
      return errorResponse("Strapi integration is not enabled", 403);
    }
    if (result.kind === "bad_request") {
      return errorResponse(result.message, 400);
    }
    return Response.json({
      success: true,
      kind: result.webhookKind,
      queued: result.queued,
    });
  },
);

export const zeroStrapiEventsRoutes: readonly RouteEntry[] = [
  { route: zeroStrapiEventsContract.post, handler: post$ },
];
