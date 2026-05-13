import { env } from "../../../env";
import { logger } from "../../shared/logger";

const log = logger("agentphone");

interface AgentPhoneSentMessage {
  id: string;
  status: string;
  channel: string | null;
  fromNumber: string | null;
  toNumber: string | null;
  mediaUrls: string[];
}

function agentPhoneApiBase(): string {
  const baseUrl = env().AGENTPHONE_API_BASE_URL;
  if (!baseUrl) {
    throw new Error("AGENTPHONE_API_BASE_URL is not configured");
  }
  return baseUrl;
}

interface AgentPhoneApiError extends Error {
  name: "AgentPhoneApiError";
  status: number;
  body: string;
}

function makeAgentPhoneApiError(
  status: number,
  body: string,
): AgentPhoneApiError {
  return Object.assign(new Error(`AgentPhone API error: ${status}`), {
    name: "AgentPhoneApiError" as const,
    status,
    body,
  });
}

export function isAgentPhoneApiError(
  error: unknown,
): error is AgentPhoneApiError {
  return (
    error instanceof Error &&
    error.name === "AgentPhoneApiError" &&
    "status" in error
  );
}

export async function sendAgentPhoneMessage(opts: {
  agentphoneAgentId: string;
  toNumber: string;
  body: string;
  mediaUrl?: string | null;
  mediaUrls?: string[] | null;
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
      ...(opts.mediaUrl ? { media_url: opts.mediaUrl } : {}),
      ...(opts.mediaUrls?.length ? { media_urls: opts.mediaUrls } : {}),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    log.error("AgentPhone send message failed", {
      status: response.status,
      body: text,
    });
    throw makeAgentPhoneApiError(response.status, text);
  }

  const result = (await response.json()) as Record<string, unknown>;
  const mediaUrls = Array.isArray(result.media_urls)
    ? result.media_urls.filter((item): item is string => {
        return typeof item === "string";
      })
    : [];
  return {
    id: typeof result.id === "string" ? result.id : "unknown",
    status: typeof result.status === "string" ? result.status : "sent",
    channel: typeof result.channel === "string" ? result.channel : null,
    fromNumber:
      typeof result.from_number === "string" ? result.from_number : null,
    toNumber: typeof result.to_number === "string" ? result.to_number : null,
    mediaUrls,
  };
}

export async function sendAgentPhoneTypingIndicator(opts: {
  conversationId: string;
}): Promise<void> {
  const token = env().AGENTPHONE_API_KEY;
  if (!token) {
    throw new Error("AGENTPHONE_API_KEY is not configured");
  }

  const response = await fetch(
    `${agentPhoneApiBase()}/v1/conversations/${encodeURIComponent(
      opts.conversationId,
    )}/typing`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    log.debug("AgentPhone typing indicator failed", {
      conversationId: opts.conversationId,
      status: response.status,
      body: text,
    });
    throw makeAgentPhoneApiError(response.status, text);
  }
}
