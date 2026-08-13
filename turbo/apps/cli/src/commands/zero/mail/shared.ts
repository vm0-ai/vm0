import type { ZeroMailProvider } from "@okouai/api-contracts/contracts/zero-mail";
import { getOkouAgentId } from "../../../lib/okou-env";

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
  const agentId = getOkouAgentId()?.trim();
  if (!agentId) {
    throw new Error("OKOU_AGENT_ID is not set", {
      cause: new Error("Run this command from an active agent run"),
    });
  }
  return agentId;
}
