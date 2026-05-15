import { uniqueId } from "../../../../../src/__tests__/test-helpers";
import {
  createTestOrg,
  insertOrgModelPolicy,
  insertOrgDefaultModelProvider,
} from "../../../../../src/__tests__/db-test-seeders/org";
import {
  createTestComposeVersion,
  seedTestCompose,
} from "../../../../../src/__tests__/db-test-seeders/agents";
import { seedTestVoiceChatSession } from "../../../../../src/__tests__/db-test-seeders/voice-chat";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

export async function setupVoiceChatOrg(userId: string): Promise<{
  orgId: string;
  slug: string;
}> {
  const slug = uniqueId("vcc");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  // Trigger-reasoning tests spawn zero runs; createZeroRun asserts an
  // org-default model provider exists. Seeding here keeps per-test setup lean.
  const modelProviderId = await insertOrgDefaultModelProvider(
    orgId,
    "anthropic-api-key",
    "claude-3-5-sonnet-20241022",
  );
  await insertOrgModelPolicy({
    orgId,
    model: "claude-sonnet-4-6",
    isDefault: true,
    defaultProviderType: "anthropic-api-key",
    credentialScope: "org",
    modelProviderId,
  });
  return { orgId, slug };
}

export async function seedVoiceChatAgent(
  userId: string,
  orgId: string,
): Promise<{ agentId: string }> {
  const { composeId } = await seedTestCompose({
    userId,
    orgId,
    name: uniqueId("vcc-agent"),
  });
  // createZeroRun requires a head version; trigger-reasoning tests need this,
  // and other tests don't care either way.
  await createTestComposeVersion(composeId, userId);
  return { agentId: composeId };
}

export async function seedVoiceChatSession(opts: {
  orgId: string;
  userId: string;
  agentId: string;
}): Promise<{ id: string }> {
  const id = await seedTestVoiceChatSession(opts);
  return { id };
}
