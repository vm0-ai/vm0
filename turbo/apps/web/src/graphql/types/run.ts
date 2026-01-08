import { builder } from "../builder";
import { RunStatus, type RunStatusType } from "./enums";

/**
 * Run type shape (maps to agent_runs table)
 */
export interface RunShape {
  id: string;
  agentComposeVersionId: string;
  status: RunStatusType;
  prompt: string;
  vars: Record<string, string> | null;
  sandboxId: string | null;
  result: unknown;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

/**
 * Run type
 * Represents a single execution of an agent
 */
export const RunType = builder.objectRef<RunShape>("Run");

RunType.implement({
  description: "An agent run execution",
  fields: (t) => ({
    id: t.exposeID("id", { description: "Unique run ID" }),
    agentComposeVersionId: t.exposeString("agentComposeVersionId", {
      description: "Agent compose version ID (SHA-256 hash)",
    }),
    status: t.expose("status", {
      type: RunStatus,
      description: "Current run status",
    }),
    prompt: t.exposeString("prompt", {
      description: "User prompt for this run",
    }),
    vars: t.field({
      type: "JSON",
      nullable: true,
      resolve: (parent) => parent.vars,
      description: "Variables passed to the run",
    }),
    sandboxId: t.exposeString("sandboxId", {
      nullable: true,
      description: "Sandbox ID where the run is executing",
    }),
    result: t.field({
      type: "JSON",
      nullable: true,
      resolve: (parent) => parent.result,
      description: "Run result (when completed)",
    }),
    error: t.exposeString("error", {
      nullable: true,
      description: "Error message (when failed)",
    }),
    createdAt: t.field({
      type: "DateTime",
      resolve: (parent) => parent.createdAt,
      description: "Creation timestamp",
    }),
    startedAt: t.field({
      type: "DateTime",
      nullable: true,
      resolve: (parent) => parent.startedAt,
      description: "Start timestamp",
    }),
    completedAt: t.field({
      type: "DateTime",
      nullable: true,
      resolve: (parent) => parent.completedAt,
      description: "Completion timestamp",
    }),
  }),
});
