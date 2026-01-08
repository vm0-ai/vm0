import { builder } from "../builder";

/**
 * RunEvent type - Events emitted during run execution
 */
export interface RunEventShape {
  id: string;
  runId: string;
  eventType: string;
  eventData: unknown;
  timestamp: Date;
}

export const RunEventType = builder.objectRef<RunEventShape>("RunEvent");

RunEventType.implement({
  description: "An event from a running agent",
  fields: (t) => ({
    id: t.exposeID("id", { description: "Event ID" }),
    runId: t.exposeID("runId", { description: "Run ID this event belongs to" }),
    eventType: t.exposeString("eventType", {
      description: "Type of event (e.g., 'assistant', 'tool_use', 'result')",
    }),
    eventData: t.field({
      type: "JSON",
      resolve: (parent) => parent.eventData,
      description: "Event payload data",
    }),
    timestamp: t.field({
      type: "DateTime",
      resolve: (parent) => parent.timestamp,
      description: "When the event occurred",
    }),
  }),
});
