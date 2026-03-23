import { type NextRequest, NextResponse, after } from "next/server";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { initServices } from "../../../../src/lib/init-services";
import { logger } from "../../../../src/lib/logger";
import { cleanupOrgExternalServices } from "../../../../src/lib/org/org-external-cleanup";
import { deleteOrgS3Data } from "../../../../src/lib/org/org-s3-cleanup";
import { deleteOrgData } from "../../../../src/lib/org/org-deletion-service";

const log = logger("webhook:clerk");

/**
 * Clerk Webhook Endpoint
 *
 * POST /api/webhooks/clerk
 *
 * Handles incoming Clerk webhook events with Svix signature verification.
 * Handles:
 * - organization.deleted — cascade cleanup of all org-scoped data
 * - organizationMembership.deleted — intentional no-op (handled by org deletion)
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
    case "organization.deleted": {
      const orgId = evt.data.id;
      if (!orgId) {
        log.error("organization.deleted event missing org ID", {
          data: evt.data,
        });
        break;
      }

      log.info("organization.deleted — starting cleanup", { orgId });

      // Use after() to run cleanup after returning 200 to Clerk.
      // This prevents Clerk from retrying due to timeout on large orgs.
      after(async () => {
        try {
          // Phase 1: External services (needs DB data — must run first)
          await cleanupOrgExternalServices(orgId);

          // Phase 2: S3 cleanup (needs DB data — must run before DB deletion)
          await deleteOrgS3Data(orgId);

          // Phase 3: Database cleanup (deletes all org-scoped rows)
          await deleteOrgData(orgId);

          log.info("organization.deleted — cleanup complete", { orgId });
        } catch (error) {
          log.error("organization.deleted — cleanup failed", { orgId, error });
        }
      });

      break;
    }

    case "organizationMembership.deleted":
      // When Clerk deletes an org, it may also fire organizationMembership.deleted
      // for each member. We handle all member cleanup in organization.deleted,
      // so this is intentionally a no-op to avoid conflicting with org deletion.
      log.debug("organizationMembership.deleted received (no-op)", {
        orgId: evt.data.organization?.id,
        userId: evt.data.public_user_data?.user_id,
      });
      break;

    default:
      log.debug("ignoring unhandled Clerk event", { type: evt.type });
  }

  return new Response("OK", { status: 200 });
}
