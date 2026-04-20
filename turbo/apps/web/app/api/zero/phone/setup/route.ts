import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { orgMetadata } from "../../../../../src/db/schema/org-metadata";
import { zeroAgents } from "../../../../../src/db/schema/zero-agent";
import { getAgentPhoneClient } from "../../../../../src/lib/zero/phone/agentphone-client";
import { buildReceptionistPrompt } from "../../../../../src/lib/zero/phone/receptionist-prompt";
import { env } from "../../../../../src/env";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("api:phone:setup");

/**
 * POST /api/zero/phone/setup — provision a phone number for an org.
 * Requires admin role.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { org, member } = await resolveOrg(authCtx);

  // Require admin role
  if (member.role !== "admin") {
    return NextResponse.json(
      { error: "Only org admins can set up phone" },
      { status: 403 },
    );
  }

  // Check tier and existing config
  const [existing] = await globalThis.services.db
    .select({
      agentphoneAgentId: orgMetadata.agentphoneAgentId,
      tier: orgMetadata.tier,
      defaultAgentId: orgMetadata.defaultAgentId,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, org.orgId))
    .limit(1);

  if (existing?.tier !== "team") {
    return NextResponse.json(
      { error: "Phone is only available on the Team plan" },
      { status: 403 },
    );
  }

  if (existing?.agentphoneAgentId) {
    return NextResponse.json(
      { error: "Phone is already configured for this org" },
      { status: 409 },
    );
  }

  const apiUrl = env().VM0_API_URL;
  if (!apiUrl) {
    throw new Error("VM0_API_URL is required for phone setup");
  }

  // Resolve default agent's display name for the receptionist persona
  let agentDisplayName = "Zero";
  if (existing?.defaultAgentId) {
    const [zeroAgent] = await globalThis.services.db
      .select({ displayName: zeroAgents.displayName })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, existing.defaultAgentId))
      .limit(1);
    if (zeroAgent?.displayName) {
      agentDisplayName = zeroAgent.displayName;
    }
  }

  const client = getAgentPhoneClient();

  // 1. Create AgentPhone agent with the org's default agent name
  const agent = await client.agents.createAgent({
    name: agentDisplayName,
    voiceMode: "hosted",
    systemPrompt: buildReceptionistPrompt(agentDisplayName),
    beginMessage: `Hello, you've reached ${agentDisplayName}. How can I help you today?`,
  });

  const agentId = agent.id;

  // 2. Provision a phone number
  const number = await client.numbers.createNumber({ country: "US" });
  const numberId = number.id;
  const phoneNumber = number.phoneNumber;

  // 3. Attach number to agent
  await client.agents.attachNumberToAgent({
    agent_id: agentId,
    numberId,
  });

  // 4. Configure per-agent webhook
  const webhookUrl = `${apiUrl}/api/zero/phone/webhook`;
  await client.agentWebhooks.createOrUpdateAgentWebhook({
    agent_id: agentId,
    body: { url: webhookUrl },
  });

  // 5. Save to org_metadata
  await globalThis.services.db
    .update(orgMetadata)
    .set({
      agentphoneAgentId: agentId,
      agentphoneNumberId: numberId,
      agentphoneNumber: phoneNumber,
      updatedAt: new Date(),
    })
    .where(eq(orgMetadata.orgId, org.orgId));

  log.info("Phone setup complete", {
    orgId: org.orgId,
    agentId,
    phoneNumber,
  });

  return NextResponse.json({
    phoneNumber,
    agentId,
  });
}
