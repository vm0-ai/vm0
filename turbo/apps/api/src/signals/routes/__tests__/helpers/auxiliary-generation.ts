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
      "chat_initial_thinking",
      "run_summary",
      "recommended_followups",
      "notification_summary",
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
    // Present only when the provider sent Retry-After on this failure.
    retry_after_ms: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    // Present only when the caller supplied a run to correlate against.
    run_id: z.string().optional(),
  })
  .strict();

type AuxiliaryFeature = z.infer<typeof resultSchema>["feature"];

export function auxiliaryResults(
  context: TestContext,
  feature?: AuxiliaryFeature,
) {
  return allAuxiliaryResults(context).filter((result) => {
    return feature === undefined || result.feature === feature;
  });
}

function allAuxiliaryResults(context: TestContext) {
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

const diagnosticLevels = ["debug", "info", "warn", "error"] as const;

const diagnosticSchema = z.object({
  feature: z.string(),
  reason: z.string(),
  errorKind: z.string(),
  threadId: z.string().optional(),
  runId: z.string().optional(),
  status: z.number().optional(),
});

/**
 * Every diagnostic level, so a caller that stops reporting an expected outcome
 * is proved silent rather than merely quieter: a reappearance at info or debug
 * fails the same assertion as a reappearance at warn.
 */
export function auxiliaryDiagnostics(
  context: TestContext,
  feature?: AuxiliaryFeature,
) {
  return diagnosticLevels.flatMap((level) => {
    return context.mocks.axiomLogging[level].mock.calls
      .filter(([message]) => {
        return message === "Auxiliary generation failed";
      })
      .map(([, fields]) => {
        return { level, ...diagnosticSchema.parse(fields) };
      })
      .filter((diagnostic) => {
        return feature === undefined || diagnostic.feature === feature;
      });
  });
}
