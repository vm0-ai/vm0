import { env } from "../../../env";
import { logger } from "../../shared/logger";

const log = logger("phone:imessage");

interface SendMessageResult {
  messageId: string;
  status: string;
}

/**
 * Send a text message (iMessage/SMS) via AgentPhone REST API.
 *
 * Uses POST /v1/messages — the SDK doesn't expose this endpoint,
 * so we call it directly.
 */
export async function sendIMessage(opts: {
  agentId: string;
  toNumber: string;
  body: string;
}): Promise<SendMessageResult> {
  const token = env().AGENTPHONE_API_KEY;
  if (!token) {
    throw new Error("AGENTPHONE_API_KEY is not configured");
  }

  const apiBase = env().AGENTPHONE_API_BASE_URL;
  if (!apiBase) {
    throw new Error("AGENTPHONE_API_BASE_URL is not configured");
  }
  const response = await fetch(`${apiBase}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agent_id: opts.agentId,
      to_number: opts.toNumber,
      body: opts.body,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => {
      return "unknown";
    });
    log.error("AgentPhone sendMessage failed", {
      status: response.status,
      body: text,
    });
    throw new Error(`AgentPhone sendMessage failed: ${response.status}`);
  }

  const result = (await response.json()) as Record<string, unknown>;
  const messageId =
    typeof result.id === "string"
      ? result.id
      : typeof result.messageId === "string"
        ? result.messageId
        : "unknown";

  return {
    messageId,
    status: typeof result.status === "string" ? result.status : "sent",
  };
}
