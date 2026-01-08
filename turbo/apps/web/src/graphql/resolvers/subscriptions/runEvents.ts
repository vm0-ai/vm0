import { builder } from "../../builder";
import { RunEventType, type RunEventShape } from "../../types/events";

/**
 * Subscription: runEvents(runId: ID!)
 * Subscribe to events from a specific run
 *
 * Note: This is a placeholder implementation for the spike.
 * Full implementation would use a pub/sub system (Redis, etc.)
 * to stream events in real-time as they're received from the sandbox.
 */
builder.subscriptionField("runEvents", (t) =>
  t.field({
    type: RunEventType,
    authScopes: { authenticated: true },
    args: {
      runId: t.arg.id({
        required: true,
        description: "Run ID to subscribe to",
      }),
    },
    subscribe: async function* (_parent, args) {
      // Placeholder: yield a single "connected" event
      // In production, this would connect to a pub/sub channel
      // and yield events as they arrive
      const mockEvent: RunEventShape = {
        id: crypto.randomUUID(),
        runId: String(args.runId),
        eventType: "subscription_connected",
        eventData: {
          message: "Subscription established (spike placeholder)",
        },
        timestamp: new Date(),
      };

      yield mockEvent;

      // Note: In a real implementation, this generator would:
      // 1. Verify the user owns the run
      // 2. Subscribe to a Redis pub/sub channel for run events
      // 3. Yield events as they're published
      // 4. Clean up subscription on disconnect
    },
    resolve: (event) => event,
  }),
);
