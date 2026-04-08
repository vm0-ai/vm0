import { eq } from "drizzle-orm";
import { initServices } from "../../../init-services";
import { orgMetadata } from "../../../../db/schema/org-metadata";
import { phoneUserLinks } from "../../../../db/schema/phone-user-link";
import { agentComposes } from "../../../../db/schema/agent-compose";
import { insertOrgCacheEntry } from "../../../../__tests__/api-test-helpers";
import { uniqueId } from "../../../../__tests__/test-helpers";

/**
 * Create an org configured with an AgentPhone agent ID and a default agent compose.
 * Sets up org_metadata with agentphoneAgentId + defaultAgentId.
 */
export async function createPhoneOrg(orgId: string): Promise<{
  orgId: string;
  composeId: string;
  agentphoneAgentId: string;
}> {
  initServices();

  const agentphoneAgentId = uniqueId("ap-agent");

  // Insert an org cache entry so slug lookups work
  await insertOrgCacheEntry({ orgId, slug: uniqueId("org") });

  // Create a compose owned by this org
  const userId = uniqueId("test-user");
  const [compose] = await globalThis.services.db
    .insert(agentComposes)
    .values({
      userId,
      orgId,
      name: uniqueId("test-compose"),
    })
    .returning();

  if (!compose) {
    throw new Error("Failed to create agent compose for phone org");
  }

  // Configure org_metadata with agentphone agent ID and default agent
  await globalThis.services.db
    .update(orgMetadata)
    .set({
      agentphoneAgentId,
      defaultAgentId: compose.id,
    })
    .where(eq(orgMetadata.orgId, orgId));

  return {
    orgId,
    composeId: compose.id,
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
