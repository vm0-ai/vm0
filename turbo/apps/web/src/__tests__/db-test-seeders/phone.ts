import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { env } from "../../env";
import { orgMetadata } from "../../db/schema/org-metadata";
import { phoneUserLinks } from "../../db/schema/phone-user-link";
import { pendingOutboundCalls } from "../../db/schema/pending-outbound-call";
import { uniqueId } from "../test-helpers";
import { createTestCompose } from "../api-test-helpers/agents";
import { ensureOrgRow } from "../api-test-helpers/org";
import { POST as linkIMessageRoute } from "../../../app/api/integrations/imessage/link/route";

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

  // Create a compose with headVersionId via the API so it can be used in run creation.
  // Agent name is randomized per call so the content-addressed compose version id
  // differs across concurrent tests — otherwise identical compose content hashes to
  // the same primary key and racing inserts collide on agent_compose_versions_pkey.
  const { composeId } = await createTestCompose(uniqueId("phone-agent"));

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

/**
 * Clear the default agent for an org, simulating a state where no default agent
 * is configured. Used to test fire-and-forget validation paths.
 *
 * @why-db-direct No API endpoint to remove the default agent from org_metadata.
 */
export async function clearOrgDefaultAgent(orgId: string): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(orgMetadata)
    .set({ defaultAgentId: null })
    .where(eq(orgMetadata.orgId, orgId));
}

/**
 * Insert a pending outbound call record for testing.
 * Simulates the state set by fire-and-forget POST before the call_ended webhook fires.
 *
 * @why-db-direct No standalone API to insert pending_outbound_calls; the record
 * is normally created as a side effect of the POST /api/zero/phone-calls route.
 */
export async function insertPendingOutboundCall(opts: {
  callId: string;
  orgId: string;
  userId: string;
  agentId: string;
  sessionId?: string;
  createdAt?: Date;
}): Promise<void> {
  initServices();
  await globalThis.services.db.insert(pendingOutboundCalls).values({
    callId: opts.callId,
    orgId: opts.orgId,
    userId: opts.userId,
    agentId: opts.agentId,
    sessionId: opts.sessionId ?? null,
    createdAt: opts.createdAt,
  });
}

/**
 * Link an iMessage handle (phone number) to a user in an org for testing.
 *
 * Calls the real POST /api/integrations/imessage/link route handler with a
 * freshly signed connect token so the same validation path used in production
 * is exercised. Requires the Clerk mock to be active for the target userId
 * (e.g. via context.setupUser()) so that auth() resolves correctly.
 */
export async function linkIMessageHandle(
  imessageHandle: string,
  orgId: string,
): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signingKey = env().SECRETS_ENCRYPTION_KEY;
  const data = `imessage:${imessageHandle}:${orgId}:${timestamp}`;
  const signature = createHmac("sha256", signingKey).update(data).digest("hex");

  const request = new Request(
    "http://localhost/api/integrations/imessage/link",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        handle: imessageHandle,
        orgId,
        timestamp,
        signature,
      }),
    },
  );

  const response = await linkIMessageRoute(request);

  if (!response.ok) {
    const body = await response.json();
    throw new Error(
      `linkIMessageHandle seeder failed (${response.status}): ${JSON.stringify(body)}`,
    );
  }
}
