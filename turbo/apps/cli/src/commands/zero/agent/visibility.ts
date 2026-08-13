import {
  zeroAgentVisibilitySchema,
  type ZeroAgentVisibility,
} from "@okouai/api-contracts/contracts/zero-agents";
import { InvalidArgumentError } from "commander";

export function parseAgentVisibility(value: string): ZeroAgentVisibility {
  const result = zeroAgentVisibilitySchema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  throw new InvalidArgumentError(
    `visibility must be one of: ${zeroAgentVisibilitySchema.options.join(", ")}`,
  );
}
