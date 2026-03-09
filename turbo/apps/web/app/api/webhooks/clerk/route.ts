import { NextRequest, NextResponse, after } from "next/server";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import {
  handleMembershipCreated,
  handleMembershipUpdated,
  handleMembershipDeleted,
} from "../../../../src/lib/clerk/handlers/membership-event";
import { handleUserDeleted } from "../../../../src/lib/clerk/handlers/user-event";
import { handleOrganizationDeleted } from "../../../../src/lib/clerk/handlers/organization-event";
import { logger } from "../../../../src/lib/logger";

const log = logger("webhook:clerk");

/**
 * Clerk Webhook Endpoint
 *
 * POST /api/webhooks/clerk
 *
 * Handles incoming events from Clerk:
 * - organizationMembership.created/updated/deleted — sync scope_members
 * - user.deleted — clean up scope_members for deleted user
 * - organization.deleted — orphan the corresponding scope
 *
 * Uses Next.js after() to process events in the background.
 */
export async function POST(request: NextRequest) {
  const { CLERK_WEBHOOK_SIGNING_SECRET } = env();

  if (!CLERK_WEBHOOK_SIGNING_SECRET) {
    return NextResponse.json(
      { error: "Clerk webhook integration is not configured" },
      { status: 503 },
    );
  }

  let evt;
  try {
    evt = await verifyWebhook(request);
  } catch (err) {
    log.error("Webhook verification failed", { error: err });
    return NextResponse.json(
      { error: "Webhook verification failed" },
      { status: 400 },
    );
  }

  initServices();

  if (evt.type === "organizationMembership.created") {
    after(
      handleMembershipCreated(evt.data).catch((error) => {
        log.error("Error handling organizationMembership.created", { error });
      }),
    );
    return new Response("OK", { status: 200 });
  }

  if (evt.type === "organizationMembership.updated") {
    after(
      handleMembershipUpdated(evt.data).catch((error) => {
        log.error("Error handling organizationMembership.updated", { error });
      }),
    );
    return new Response("OK", { status: 200 });
  }

  if (evt.type === "organizationMembership.deleted") {
    after(
      handleMembershipDeleted(evt.data).catch((error) => {
        log.error("Error handling organizationMembership.deleted", { error });
      }),
    );
    return new Response("OK", { status: 200 });
  }

  if (evt.type === "user.deleted") {
    after(
      handleUserDeleted(evt.data).catch((error) => {
        log.error("Error handling user.deleted", { error });
      }),
    );
    return new Response("OK", { status: 200 });
  }

  if (evt.type === "organization.deleted") {
    after(
      handleOrganizationDeleted(evt.data).catch((error) => {
        log.error("Error handling organization.deleted", { error });
      }),
    );
    return new Response("OK", { status: 200 });
  }

  log.debug("Ignoring unhandled Clerk event", { type: evt.type });
  return new Response("OK", { status: 200 });
}
