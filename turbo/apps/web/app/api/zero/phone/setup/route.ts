import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { orgMetadata } from "../../../../../src/db/schema/org-metadata";
import { getAgentPhoneClient } from "../../../../../src/lib/zero/phone/agentphone-client";
import { RECEPTIONIST_SYSTEM_PROMPT } from "../../../../../src/lib/zero/phone/receptionist-prompt";
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

  // Check if already configured
  const [existing] = await globalThis.services.db
    .select({ agentphoneAgentId: orgMetadata.agentphoneAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, org.orgId))
    .limit(1);

  if (existing?.agentphoneAgentId) {
    return NextResponse.json(
      { error: "Phone is already configured for this org" },
      { status: 409 },
    );
  }

  const apiUrl = env().VM0_API_URL;
  if (!apiUrl) {
    return NextResponse.json(
      { error: "Platform API URL not configured" },
      { status: 500 },
    );
  }

  const client = getAgentPhoneClient();

  try {
    // 1. Create AgentPhone agent
    const agent = await client.agents.createAgent({
      name: `Zero - ${org.orgId}`,
      voiceMode: "hosted",
      systemPrompt: RECEPTIONIST_SYSTEM_PROMPT,
      beginMessage: "Hello, you've reached Zero. How can I help you today?",
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
  } catch (err) {
    log.error("Phone setup failed", { orgId: org.orgId, error: err });
    const message =
      err instanceof Error ? err.message : "Failed to set up phone";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
