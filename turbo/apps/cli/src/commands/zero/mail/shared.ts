import type { ZeroMailProvider } from "@vm0/api-contracts/contracts/zero-mail";

export const MAIL_CONNECTOR_SLUG_BY_PROVIDER = {
  gmail: "gmail",
  outlook: "outlook-mail",
} as const;

export function parseMailProvider(value: string): ZeroMailProvider {
  if (value === "gmail" || value === "outlook") {
    return value;
  }
  throw new Error(`Unsupported mail provider: ${value}`, {
    cause: new Error("Use gmail or outlook"),
  });
}

export function currentAgentId(): string {
  const agentId = process.env.ZERO_AGENT_ID?.trim();
  if (!agentId) {
    throw new Error("ZERO_AGENT_ID is not set", {
      cause: new Error("Run this command from an active Zero agent run"),
    });
  }
  return agentId;
}
