import { eq } from "drizzle-orm";
import { orgMetadata } from "../../../db/schema/org-metadata";
import { getAgentPhoneClient } from "./agentphone-client";
import { logger } from "../../shared/logger";

const log = logger("phone:calls");

/**
 * Create an outbound phone call via AgentPhone.
 * The platform acts as intermediary — the sandbox never talks to AgentPhone directly.
 */
export async function createOutboundCall(
  orgId: string,
  toNumber: string,
  opts?: { greeting?: string; systemPrompt?: string },
): Promise<{ callId: string; status: string }> {
  const [org] = await globalThis.services.db
    .select({
      agentphoneAgentId: orgMetadata.agentphoneAgentId,
      agentphoneNumberId: orgMetadata.agentphoneNumberId,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  if (!org?.agentphoneAgentId) {
    throw new Error("Phone is not configured for this org");
  }

  const client = getAgentPhoneClient();
  const result = await client.calls.createOutboundCall({
    agentId: org.agentphoneAgentId,
    toNumber,
    fromNumberId: org.agentphoneNumberId ?? undefined,
    initialGreeting: opts?.greeting ?? undefined,
    systemPrompt: opts?.systemPrompt ?? undefined,
  });

  const callResult = result as unknown as Record<string, unknown>;
  const callId =
    typeof callResult.id === "string"
      ? callResult.id
      : typeof callResult.callId === "string"
        ? callResult.callId
        : "unknown";

  log.info("Outbound call created", { orgId, toNumber, callId });
  return {
    callId,
    status:
      typeof callResult.status === "string" ? callResult.status : "initiated",
  };
}

/**
 * List recent calls for an org's AgentPhone agent.
 */
export async function listPhoneCalls(
  orgId: string,
  opts?: { limit?: number; offset?: number },
): Promise<{
  data: Array<Record<string, unknown>>;
  total: number;
  hasMore: boolean;
}> {
  const [org] = await globalThis.services.db
    .select({ agentphoneAgentId: orgMetadata.agentphoneAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  if (!org?.agentphoneAgentId) {
    return { data: [], total: 0, hasMore: false };
  }

  const client = getAgentPhoneClient();
  const result = await client.agents.listAgentCalls({
    agent_id: org.agentphoneAgentId,
  });

  const calls = result as unknown as Record<string, unknown>;
  const items = Array.isArray(calls.data)
    ? calls.data
    : Array.isArray(calls)
      ? calls
      : [];

  const limit = opts?.limit ?? 20;
  const offset = opts?.offset ?? 0;
  const sliced = items.slice(offset, offset + limit) as Array<
    Record<string, unknown>
  >;

  return {
    data: sliced,
    total: items.length,
    hasMore: offset + limit < items.length,
  };
}

/**
 * Get call detail + transcript for a specific call.
 */
export async function getPhoneCallDetail(
  orgId: string,
  callId: string,
): Promise<{
  call: Record<string, unknown>;
  transcript: unknown;
} | null> {
  const [org] = await globalThis.services.db
    .select({ agentphoneAgentId: orgMetadata.agentphoneAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  if (!org?.agentphoneAgentId) {
    return null;
  }

  const client = getAgentPhoneClient();

  const [call, transcript] = await Promise.all([
    client.calls.getCall({ call_id: callId }),
    client.calls.getCallTranscript({ call_id: callId }),
  ]);

  // Verify call belongs to this org's agent
  const callData = call as unknown as Record<string, unknown>;
  if (
    callData.agentId !== org.agentphoneAgentId &&
    callData.agent_id !== org.agentphoneAgentId
  ) {
    return null;
  }

  return { call: callData, transcript };
}
