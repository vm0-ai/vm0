import { builder } from "../builder";

/**
 * Agent type shape (maps to agent_composes table)
 */
export interface AgentShape {
  id: string;
  name: string;
  headVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Agent type
 * Represents a deployable agent configuration
 */
export const AgentType = builder.objectRef<AgentShape>("Agent");

AgentType.implement({
  description: "An agent configuration",
  fields: (t) => ({
    id: t.exposeID("id", { description: "Unique agent ID" }),
    name: t.exposeString("name", { description: "Agent name" }),
    headVersionId: t.exposeString("headVersionId", {
      nullable: true,
      description: "Current HEAD version ID (SHA-256 hash)",
    }),
    createdAt: t.field({
      type: "DateTime",
      resolve: (parent) => parent.createdAt,
      description: "Creation timestamp",
    }),
    updatedAt: t.field({
      type: "DateTime",
      resolve: (parent) => parent.updatedAt,
      description: "Last update timestamp",
    }),
  }),
});
