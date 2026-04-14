import { eq } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { orgMetadata } from "../../db/schema/org-metadata";
import { phoneUserLinks } from "../../db/schema/phone-user-link";
import { uniqueId } from "../test-helpers";
import { createTestCompose } from "../api-test-helpers/agents";
import { ensureOrgRow } from "../api-test-helpers/org";

// ============================================================================
// Phone Seeders
// ============================================================================

/**
 * Set the AgentPhone number ID on org_metadata.
 * Used when a test needs a number ID attached to the org for outbound call tests.
 *
 * @why-db-direct Updates a single metadata field; no API endpoint exists for
 * partial org_metadata updates.
 */
export async function setOrgAgentphoneNumberId(
  orgId: string,
  numberId: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(orgMetadata)
    .set({ agentphoneNumberId: numberId })
    .where(eq(orgMetadata.orgId, orgId));
}

/**
 * Create an org configured with an AgentPhone agent ID and a default agent compose.
 * Sets up org_metadata with agentphoneAgentId + defaultAgentId.
 *
 * The compose is created via createTestCompose() so it has a headVersionId,
 * making it usable in createZeroRun() test scenarios.
 *
 * Callers must have the Clerk mock set up (e.g., via context.setupUser()) so
 * the compose is owned by the correct user/org context.
 *
 * @why-db-direct Combines ensureOrgRow() + createTestCompose() + DB update to
 * set up impossible test state (agentphoneAgentId + defaultAgentId) that cannot
 * be reached through any single API.
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
 *
 * @why-db-direct No API endpoint for directly linking phone numbers; the setup
 * route has different semantics.
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
