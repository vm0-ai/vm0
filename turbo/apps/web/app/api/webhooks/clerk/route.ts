import { type NextRequest, NextResponse } from "next/server";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { initServices } from "../../../../src/lib/init-services";
import { logger } from "../../../../src/lib/logger";

const log = logger("webhook:clerk");

/**
 * Clerk Webhook Endpoint
 *
 * POST /api/webhooks/clerk
 *
 * Handles incoming Clerk webhook events with Svix signature verification.
 * Currently handles:
 * - organization.deleted — placeholder for cascade cleanup (wired in later sub-issue)
 */
export async function POST(request: NextRequest) {
  initServices();

  let evt;
  try {
    evt = await verifyWebhook(request);
  } catch {
    return NextResponse.json(
      { error: "Invalid webhook signature" },
      { status: 401 },
    );
  }

  log.info("clerk webhook received", { type: evt.type });

  switch (evt.type) {
    case "organization.deleted":
      log.info("organization.deleted received", { orgId: evt.data.id });
      // Cleanup logic will be wired in a subsequent sub-issue
      break;
    default:
      log.debug("ignoring unhandled Clerk event", { type: evt.type });
  }

  return new Response("OK", { status: 200 });
}
