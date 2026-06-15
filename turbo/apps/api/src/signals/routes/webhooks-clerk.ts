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
  cleanupClerkBannedUser$,
  cleanupClerkDeletedOrgMembership$,
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

function propertyOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return Reflect.get(value, key);
}

function stringPropertyOf(value: unknown, key: string): string | undefined {
  const property = propertyOf(value, key);
  return typeof property === "string" ? property : undefined;
}

function organizationMembershipIdentity(data: unknown):
  | {
      readonly orgId: string;
      readonly userId: string;
    }
  | undefined {
  const organization = propertyOf(data, "organization");
  const orgId =
    stringPropertyOf(organization, "id") ??
    stringPropertyOf(data, "organization_id");
  const publicUserData =
    propertyOf(data, "publicUserData") ?? propertyOf(data, "public_user_data");
  const userId =
    stringPropertyOf(publicUserData, "userId") ??
    stringPropertyOf(publicUserData, "user_id") ??
    stringPropertyOf(data, "user_id");

  return orgId && userId ? { orgId, userId } : undefined;
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

    // "user.banned" is not yet in the Clerk SDK WebhookEvent type union
    if ((event.type as string) === "user.banned") {
      const { data } = event as unknown as { data: unknown };
      const userId = eventDataId(data);
      if (!userId) {
        L.error("user.banned event missing user ID", { data });
        return new Response("OK", { status: 200 });
      }

      waitUntil(
        tapError(set(cleanupClerkBannedUser$, userId, signal), (error) => {
          L.error("user.banned cleanup failed", { userId, error });
        }),
      );
      return new Response("OK", { status: 200 });
    }

    if (event.type === "organizationMembership.deleted") {
      const identity = organizationMembershipIdentity(event.data);
      if (!identity) {
        L.error("organizationMembership.deleted event missing org/user ID", {
          data: event.data,
        });
        return new Response("OK", { status: 200 });
      }

      waitUntil(
        tapError(
          set(cleanupClerkDeletedOrgMembership$, identity, signal),
          (error) => {
            L.error("organizationMembership.deleted cleanup failed", {
              ...identity,
              error,
            });
          },
        ),
      );
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
