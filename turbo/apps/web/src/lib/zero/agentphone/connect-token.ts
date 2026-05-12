import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_CONNECT_AGE_SECONDS = 600;

function normalizeHandle(handle: string): string {
  return handle.trim();
}

export function signAgentPhoneConnectParams(
  phoneHandle: string,
  agentphoneAgentId: string,
  timestamp: number,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(
      `${normalizeHandle(phoneHandle)}:${agentphoneAgentId}:${String(timestamp)}`,
    )
    .digest("hex");
}

export function verifyAgentPhoneConnectSignature(params: {
  phoneHandle: string;
  agentphoneAgentId: string;
  timestamp: number;
  signature: string;
  secret: string;
}): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - params.timestamp) > MAX_CONNECT_AGE_SECONDS) return false;

  const expected = signAgentPhoneConnectParams(
    params.phoneHandle,
    params.agentphoneAgentId,
    params.timestamp,
    params.secret,
  );
  if (!/^[0-9a-f]+$/iu.test(params.signature)) return false;

  const expectedBuffer = Buffer.from(expected, "hex");
  const signatureBuffer = Buffer.from(params.signature, "hex");
  if (expectedBuffer.length !== signatureBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, signatureBuffer);
}
