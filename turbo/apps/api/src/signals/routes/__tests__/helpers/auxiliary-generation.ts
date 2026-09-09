import { z } from "zod";
import type { TestContext } from "../../../../__tests__/test-context";

const resultSchema = z
  .object({
    _time: z.iso.datetime(),
    type: z.literal("auxiliary_generation_result"),
    source: z.literal("api"),
    feature: z.enum([
      "chat_title",
      "shared_thread_title",
      "run_summary",
      "recommended_followups",
      "notification_summary",
      "goal_objective_brief",
    ]),
    outcome: z.enum(["success", "degraded", "cancelled", "error", "skipped"]),
    reason: z.enum([
      "none",
      "rate_limited",
      "upstream_timeout",
      "network",
      "provider_unavailable",
      "caller_cancelled",
      "invalid_request",
      "auth",
      "output_truncated",
      "unexpected_tool_calls",
      "unusable_output",
      "invalid_output",
      "unknown",
      "not_applicable",
    ]),
    duration_ms: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    // Present only when the provider reported usage. Integers, never payload.
    completion_tokens: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    reasoning_tokens: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  })
  .strict();

export function auxiliaryResults(context: TestContext) {
  return [
    ...context.mocks.axiom.ingest.mock.calls,
    ...context.mocks.axiom.sdkIngest.mock.calls,
  ].flatMap((call) => {
    const events = call[1];
    if (!Array.isArray(events)) {
      return [];
    }
    return events.flatMap((event: unknown) => {
      if (
        typeof event !== "object" ||
        event === null ||
        !("type" in event) ||
        event.type !== "auxiliary_generation_result"
      ) {
        return [];
      }
      return [resultSchema.parse(event)];
    });
  });
}

export function auxiliaryWarnings(context: TestContext) {
  return context.mocks.axiomLogging.warn.mock.calls.filter(([message]) => {
    return message === "Auxiliary generation failed";
  });
}
