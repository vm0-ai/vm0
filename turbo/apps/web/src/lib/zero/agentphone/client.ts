import { env } from "../../../env";
import { logger } from "../../shared/logger";

const log = logger("agentphone");

interface AgentPhoneSentMessage {
  id: string;
  status: string;
  channel: string | null;
  fromNumber: string | null;
  toNumber: string | null;
}

function agentPhoneApiBase(): string {
  const baseUrl = env().AGENTPHONE_API_BASE_URL;
  if (!baseUrl) {
    throw new Error("AGENTPHONE_API_BASE_URL is not configured");
  }
  return baseUrl;
}

export async function sendAgentPhoneMessage(opts: {
  agentphoneAgentId: string;
  toNumber: string;
  body: string;
}): Promise<AgentPhoneSentMessage> {
  const token = env().AGENTPHONE_API_KEY;
  if (!token) {
    throw new Error("AGENTPHONE_API_KEY is not configured");
  }

  const response = await fetch(`${agentPhoneApiBase()}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agent_id: opts.agentphoneAgentId,
      to_number: opts.toNumber,
      body: opts.body,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    log.error("AgentPhone send message failed", {
      status: response.status,
      body: text,
    });
    throw new Error(`AgentPhone send message failed: ${response.status}`);
  }

  const result = (await response.json()) as Record<string, unknown>;
  return {
    id: typeof result.id === "string" ? result.id : "unknown",
    status: typeof result.status === "string" ? result.status : "sent",
    channel: typeof result.channel === "string" ? result.channel : null,
    fromNumber:
      typeof result.from_number === "string" ? result.from_number : null,
    toNumber: typeof result.to_number === "string" ? result.to_number : null,
  };
}
