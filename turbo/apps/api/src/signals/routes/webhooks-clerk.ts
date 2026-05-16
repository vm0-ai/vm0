import { verifyWebhook } from "@clerk/backend/webhooks";
import { webhookClerkContract } from "@vm0/api-contracts/contracts/webhooks";
import { command } from "ccstate";

import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { request$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import type { RouteEntry } from "../route";
import { settle, tapError } from "../utils";
import {
  cleanupClerkDeletedOrg$,
  cleanupClerkDeletedUser$,
} from "../services/webhooks-clerk-cleanup.service";

const L = logger("WebhookClerkRoute");

function jsonError(message: string, status: 401): Response {
  return Response.json({ error: message }, { status });
}

function eventDataId(data: unknown): string | undefined {
  if (
    typeof data === "object" &&
    data !== null &&
    "id" in data &&
    typeof data.id === "string"
  ) {
    return data.id;
  }
  return undefined;
}

const postClerkWebhook$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const request = get(request$).raw;
    const signingSecret = optionalEnv("CLERK_WEBHOOK_SIGNING_SECRET");

    const eventResult = await settle(
      verifyWebhook(request.clone(), { signingSecret }),
    );
    signal.throwIfAborted();
    if (!eventResult.ok) {
      return jsonError("Invalid webhook signature", 401);
    }

    const event = eventResult.value;
    L.debug("clerk webhook received", { type: event.type });

    if (event.type === "organization.deleted") {
      const orgId = eventDataId(event.data);
      if (!orgId) {
        L.error("organization.deleted event missing org ID", {
          data: event.data,
        });
        return new Response("OK", { status: 200 });
      }

      waitUntil(
        tapError(set(cleanupClerkDeletedOrg$, orgId, signal), (error) => {
          L.error("organization.deleted cleanup failed", { orgId, error });
        }),
      );
      return new Response("OK", { status: 200 });
    }

    if (event.type === "user.deleted") {
      const userId = eventDataId(event.data);
      if (!userId) {
        L.error("user.deleted event missing user ID", { data: event.data });
        return new Response("OK", { status: 200 });
      }

      waitUntil(
        tapError(set(cleanupClerkDeletedUser$, userId, signal), (error) => {
          L.error("user.deleted cleanup failed", { userId, error });
        }),
      );
      return new Response("OK", { status: 200 });
    }

    if (event.type === "organizationMembership.deleted") {
      L.debug("organizationMembership.deleted received");
      return new Response("OK", { status: 200 });
    }

    L.debug("ignoring unhandled Clerk event", { type: event.type });
    return new Response("OK", { status: 200 });
  },
);

export const webhooksClerkRoutes: readonly RouteEntry[] = [
  {
    route: webhookClerkContract.post,
    handler: postClerkWebhook$,
  },
];
