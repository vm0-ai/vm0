import {
  agentVisibilitySchema,
  type AgentVisibility,
} from "@okouai/api-contracts/contracts/agents";
import { InvalidArgumentError } from "commander";

export function parseAgentVisibility(value: string): AgentVisibility {
  const result = agentVisibilitySchema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  throw new InvalidArgumentError(
    `visibility must be one of: ${agentVisibilitySchema.options.join(", ")}`,
  );
}
