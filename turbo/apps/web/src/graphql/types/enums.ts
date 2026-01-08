import { builder } from "../builder";

/**
 * Run status enum
 * Maps to database run status values
 */
export const RunStatus = builder.enumType("RunStatus", {
  values: ["pending", "running", "completed", "failed", "timeout"] as const,
  description: "Status of an agent run",
});

export type RunStatusType =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "timeout";
