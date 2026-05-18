import {
  createTestCompose,
  createTestOrgModelProvider,
  insertOrgModelPolicy,
} from "../../../../src/__tests__/api-test-helpers";
import type { UserContext } from "../../../../src/__tests__/test-helpers";

interface TestContext {
  setupUser(): Promise<UserContext>;
}

export async function onboardNewOrgAndUser(context: TestContext): Promise<{
  user: UserContext;
  orgSlug: string;
  agent: { agentId: string };
}> {
  // 1. Setup user (Clerk session auth via mock)
  const user = await context.setupUser();
  const orgSlug = `org-${user.userId.slice(-8)}`;

  // 2. Upsert model provider
  const provider = await createTestOrgModelProvider(
    "anthropic-api-key",
    "sk-ant-test-key",
  );

  await insertOrgModelPolicy({
    orgId: user.orgId,
    model: "claude-sonnet-4-6",
    isDefault: true,
    defaultProviderType: "anthropic-api-key",
    credentialScope: "org",
    modelProviderId: provider.id,
  });

  // 3. Create a runnable agent compose. The zero agents collection route is
  // API-backend authoritative; web tests should not import the old handler.
  const agent = await createTestCompose("test-agent");

  return {
    user,
    orgSlug,
    agent: { agentId: agent.agentId },
  };
}
