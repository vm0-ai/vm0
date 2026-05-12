import { NextRequest } from "next/server";
import { POST as createAgentRoute } from "../agents/route";
import { PUT as updateInstructionsRoute } from "../agents/[id]/instructions/route";
import { POST as upsertModelProviderRoute } from "../model-providers/route";
import { insertOrgModelPolicy } from "../../../../src/__tests__/api-test-helpers";
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
  const providerRes = await upsertModelProviderRoute(
    new NextRequest(`http://localhost:3000/api/zero/model-providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "anthropic-api-key",
        secret: "sk-ant-test-key",
      }),
    }),
  );
  if (!providerRes.ok) {
    throw new Error(
      `upsertModelProviderRoute failed with status ${providerRes.status}`,
    );
  }
  const providerData = (await providerRes.json()) as {
    provider: { id: string };
  };

  await insertOrgModelPolicy({
    orgId: user.orgId,
    model: "claude-sonnet-4-6",
    isDefault: true,
    defaultProviderType: "anthropic-api-key",
    credentialScope: "org",
    modelProviderId: providerData.provider.id,
  });

  // 3. Create agent
  const agentRes = await createAgentRoute(
    new NextRequest(`http://localhost:3000/api/zero/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connectors: [],
        displayName: "Test Agent",
        description: "Created by onboardNewOrgAndUser",
      }),
    }),
  );
  if (!agentRes.ok) {
    throw new Error(`createAgentRoute failed with status ${agentRes.status}`);
  }
  const agent = (await agentRes.json()) as {
    agentId: string;
  };

  // 4. Upload instructions
  const instructionsRes = await updateInstructionsRoute(
    new NextRequest(
      `http://localhost:3000/api/zero/agents/${agent.agentId}/instructions`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "# Agent Instructions\nBe helpful.",
        }),
      },
    ),
  );
  if (!instructionsRes.ok) {
    throw new Error(
      `updateInstructionsRoute failed with status ${instructionsRes.status}`,
    );
  }

  return {
    user,
    orgSlug,
    agent: { agentId: agent.agentId },
  };
}
