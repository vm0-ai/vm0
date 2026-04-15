"use server";

import { after } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@clerk/nextjs/server";
import { initServices } from "../../../src/lib/init-services";
import { orgMetadata } from "../../../src/db/schema/org-metadata";
import { verifyConnectSignature } from "../../../src/lib/zero/phone/imessage-connect-token";
import { sendIMessage } from "../../../src/lib/zero/phone/imessage-service";
import { getMemberRole } from "../../../src/lib/auth/org-membership-cache";
import { getOrgNameAndSlug } from "../../../src/lib/auth/org-cache";
import { linkIMessageHandle } from "../../../src/lib/zero/phone/handlers/imessage-shared";
import { logger } from "../../../src/lib/shared/logger";

const log = logger("imessage:connect-action");

interface LinkResult {
  success: boolean;
  error?: string;
  orgName?: string;
}

export async function linkIMessageAction(
  handle: string,
  orgId: string,
  timestamp: number,
  signature: string,
): Promise<LinkResult> {
  const { userId } = await auth();

  if (!userId) {
    return { success: false, error: "Not authenticated" };
  }

  initServices();

  // Verify signature
  if (!verifyConnectSignature(handle, orgId, timestamp, signature)) {
    return {
      success: false,
      error:
        "Invalid or expired connect link. Please send a new message to get a fresh link.",
    };
  }

  // Verify user is a member of the org
  const role = await getMemberRole(orgId, userId);
  if (!role) {
    return {
      success: false,
      error: "You are not a member of this organization.",
    };
  }

  // Link (or update) the handle, checking for cross-org conflicts
  const linkResult = await linkIMessageHandle(handle, orgId, userId);

  if (!linkResult.ok) {
    if (linkResult.conflict) {
      return {
        success: false,
        error:
          "This iMessage account is already linked to another organization.",
      };
    }
  }

  // Get org name for display
  const orgInfo = await getOrgNameAndSlug(orgId);

  // Send success message via iMessage (fire-and-forget after response).
  // The .catch() is intentional: a delivery failure must not roll back the
  // already-committed DB link or surface an error to the user.
  const [org] = await globalThis.services.db
    .select({ agentphoneAgentId: orgMetadata.agentphoneAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  if (org?.agentphoneAgentId) {
    after(
      sendIMessage({
        agentId: org.agentphoneAgentId,
        toNumber: handle,
        body: "Account linked successfully! You can now send messages directly to your agent.",
      }).catch((err: unknown) => {
        log.warn("Failed to send link success iMessage", { err });
      }),
    );
  }

  return { success: true, orgName: orgInfo?.name ?? undefined };
}
