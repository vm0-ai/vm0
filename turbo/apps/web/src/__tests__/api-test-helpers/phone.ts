import { eq } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { orgMetadata } from "../../db/schema/org-metadata";
import { phoneUserLinks } from "../../db/schema/phone-user-link";
import { uniqueId } from "../test-helpers";
import { createTestCompose } from "./agents";
import { ensureOrgRow } from "./org";

// ============================================================================
// Phone Helpers
// ============================================================================

/**
 * Set the AgentPhone number ID on org_metadata.
 * Used when a test needs a number ID attached to the org for outbound call tests.
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
 * Get the AgentPhone provisioning config for an org from org_metadata.
 * Used to verify that setup correctly saved the agent/number IDs.
 */
export async function getOrgAgentphoneConfig(orgId: string): Promise<{
  agentphoneAgentId: string | null;
  agentphoneNumberId: string | null;
  agentphoneNumber: string | null;
}> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      agentphoneAgentId: orgMetadata.agentphoneAgentId,
      agentphoneNumberId: orgMetadata.agentphoneNumberId,
      agentphoneNumber: orgMetadata.agentphoneNumber,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return {
    agentphoneAgentId: row?.agentphoneAgentId ?? null,
    agentphoneNumberId: row?.agentphoneNumberId ?? null,
    agentphoneNumber: row?.agentphoneNumber ?? null,
  };
}

// ============================================================================
// Absorbed from lib/zero/phone/__tests__/helpers.ts
// ============================================================================

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
