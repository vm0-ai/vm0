import { createHmac, timingSafeEqual } from "node:crypto";
import type { AgentPhoneChannel } from "./shared";

const MAX_CONNECT_AGE_SECONDS = 600;

function normalizeHandle(handle: string): string {
  return handle.trim();
}

export function signAgentPhoneConnectParams(params: {
  phoneHandle: string;
  agentphoneAgentId: string;
  timestamp: number;
  channel: AgentPhoneChannel;
  secret: string;
}): string {
  return createHmac("sha256", params.secret)
    .update(
      `${normalizeHandle(params.phoneHandle)}:${params.agentphoneAgentId}:${String(
        params.timestamp,
      )}:${params.channel}`,
    )
    .digest("hex");
}

export function verifyAgentPhoneConnectSignature(params: {
  phoneHandle: string;
  agentphoneAgentId: string;
  timestamp: number;
  channel: AgentPhoneChannel;
  signature: string;
  secret: string;
}): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - params.timestamp) > MAX_CONNECT_AGE_SECONDS) return false;

  const expected = signAgentPhoneConnectParams({
    phoneHandle: params.phoneHandle,
    agentphoneAgentId: params.agentphoneAgentId,
    timestamp: params.timestamp,
    channel: params.channel,
    secret: params.secret,
  });
  if (!/^[0-9a-f]+$/iu.test(params.signature)) return false;

  const expectedBuffer = Buffer.from(expected, "hex");
  const signatureBuffer = Buffer.from(params.signature, "hex");
  if (expectedBuffer.length !== signatureBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, signatureBuffer);
}
