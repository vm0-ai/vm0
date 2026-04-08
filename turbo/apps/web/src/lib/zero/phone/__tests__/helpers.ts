import { eq } from "drizzle-orm";
import { initServices } from "../../../init-services";
import { orgMetadata } from "../../../../db/schema/org-metadata";
import { phoneUserLinks } from "../../../../db/schema/phone-user-link";
import {
  createTestCompose,
  ensureOrgRow,
} from "../../../../__tests__/api-test-helpers";
import { uniqueId } from "../../../../__tests__/test-helpers";

/**
 * Create an org configured with an AgentPhone agent ID and a default agent compose.
 * Sets up org_metadata with agentphoneAgentId + defaultAgentId.
 *
 * The compose is created via createTestCompose() so it has a headVersionId,
 * making it usable in createZeroRun() test scenarios.
 *
 * Callers must have the Clerk mock set up (e.g., via context.setupUser()) so
 * the compose is owned by the correct user/org context.
 */
export async function createPhoneOrg(orgId: string): Promise<{
  orgId: string;
  composeId: string;
  agentphoneAgentId: string;
}> {
  initServices();

  const agentphoneAgentId = uniqueId("ap-agent");

  // Ensure org_metadata row exists for this org
  await ensureOrgRow(orgId);

  // Create a compose with headVersionId via the API so it can be used in run creation
  const { composeId } = await createTestCompose("phone-test-agent");

  // Configure org_metadata with agentphone agent ID and default agent
  await globalThis.services.db
    .update(orgMetadata)
    .set({
      agentphoneAgentId,
      defaultAgentId: composeId,
    })
    .where(eq(orgMetadata.orgId, orgId));

  return {
    orgId,
    composeId,
    agentphoneAgentId,
  };
}

/**
 * Link a phone number to a user in an org for testing.
 */
export async function linkPhoneNumber(
  phoneNumber: string,
  userId: string,
  orgId: string,
): Promise<void> {
  initServices();

  await globalThis.services.db.insert(phoneUserLinks).values({
    phoneNumber,
    orgId,
    vm0UserId: userId,
    verified: true,
  });
}
