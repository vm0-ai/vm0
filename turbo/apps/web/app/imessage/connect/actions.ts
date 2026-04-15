"use server";

import { eq } from "drizzle-orm";
import { auth } from "@clerk/nextjs/server";
import { initServices } from "../../../src/lib/init-services";
import { imessageUserLinks } from "../../../src/db/schema/imessage-user-link";
import { orgMetadata } from "../../../src/db/schema/org-metadata";
import { verifyConnectSignature } from "../../../src/lib/zero/phone/imessage-connect-token";
import { sendIMessage } from "../../../src/lib/zero/phone/imessage-service";
import { getMemberRole } from "../../../src/lib/auth/org-membership-cache";
import { getOrgNameAndSlug } from "../../../src/lib/auth/org-cache";

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

  // Check if this handle is already bound to a different org
  const [existing] = await globalThis.services.db
    .select({
      orgId: imessageUserLinks.orgId,
      vm0UserId: imessageUserLinks.vm0UserId,
    })
    .from(imessageUserLinks)
    .where(eq(imessageUserLinks.imessageHandle, handle))
    .limit(1);

  if (existing && existing.orgId !== orgId) {
    return {
      success: false,
      error: "This iMessage account is already linked to another organization.",
    };
  }

  // Create or update the binding
  await globalThis.services.db
    .insert(imessageUserLinks)
    .values({
      imessageHandle: handle,
      orgId,
      vm0UserId: userId,
    })
    .onConflictDoUpdate({
      target: [imessageUserLinks.imessageHandle],
      set: {
        orgId,
        vm0UserId: userId,
        updatedAt: new Date(),
      },
    });

  // Get org name for display
  const orgInfo = await getOrgNameAndSlug(orgId);

  // Send success message via iMessage (non-blocking)
  const [org] = await globalThis.services.db
    .select({ agentphoneAgentId: orgMetadata.agentphoneAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  if (org?.agentphoneAgentId) {
    sendIMessage({
      agentId: org.agentphoneAgentId,
      toNumber: handle,
      body: "Account linked successfully! You can now send messages directly to your agent.",
    }).catch(() => {
      // non-blocking
    });
  }

  return { success: true, orgName: orgInfo?.name ?? undefined };
}
