import { eq } from "drizzle-orm";
import { orgMetadata } from "../../../db/schema/org-metadata";
import { getAgentPhoneClient } from "./agentphone-client";
import { logger } from "../../shared/logger";

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return [];
}

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

  const callResult = toRecord(result);
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
    throw new Error("Phone is not configured for this org");
  }

  const client = getAgentPhoneClient();
  const result = await client.agents.listAgentCalls({
    agent_id: org.agentphoneAgentId,
  });

  const calls = toRecord(result);
  const items = Array.isArray(calls.data)
    ? toArray(calls.data)
    : Array.isArray(result)
      ? toArray(result)
      : [];

  const limit = opts?.limit ?? 20;
  const offset = opts?.offset ?? 0;
  const sliced = items.slice(offset, offset + limit).map(toRecord);

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
    throw new Error("Phone is not configured for this org");
  }

  const client = getAgentPhoneClient();

  const [call, transcript] = await Promise.all([
    client.calls.getCall({ call_id: callId }),
    client.calls.getCallTranscript({ call_id: callId }),
  ]);

  // Verify call belongs to this org's agent
  const callData = toRecord(call);
  if (
    callData.agentId !== org.agentphoneAgentId &&
    callData.agent_id !== org.agentphoneAgentId
  ) {
    return null;
  }

  return { call: callData, transcript };
}
