import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import { flushAxiom, getDatasetName, ingestToAxiom } from "../external/axiom";
import {
  isLlmConfigured,
  OpenRouterRequestError,
} from "../external/openrouter";
import {
  openRouterFailureReason,
  type OpenRouterFailureReason,
} from "../external/openrouter-failure";
import { onRejection, safeSync, settle } from "../utils";

type AuxiliaryFeature =
  | "chat_title"
  | "run_summary"
  | "recommended_followups"
  | "notification_summary"
  | "goal_objective_brief";
type Outcome = "success" | "degraded" | "cancelled" | "error" | "skipped";
type Reason =
  | OpenRouterFailureReason
  | "none"
  | "caller_cancelled"
  | "not_applicable";
const log = logger("api:auxiliary-generation");

async function deliverResult(
  feature: AuxiliaryFeature,
  outcome: Outcome,
  reason: Reason,
  startedAt: number,
): Promise<void> {
  const elapsed = now() - startedAt;
  const ingested = safeSync(() => {
    return ingestToAxiom(getDatasetName("web-logs"), [
      {
        _time: nowDate().toISOString(),
        type: "auxiliary_generation_result",
        source: "api",
        feature,
        outcome,
        reason,
        duration_ms: Number.isFinite(elapsed)
          ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, elapsed))
          : 0,
      },
    ]);
  });
  if ("ok" in ingested && ingested.ok) {
    await flushAxiom({ client: "telemetry" });
  }
}

function recordResult(
  feature: AuxiliaryFeature,
  outcome: Outcome,
  reason: Reason,
  startedAt: number,
): void {
  // A title/callback may finish after the response's flush. Register its own
  // flush with the same request lifetime; exporter failure is never business failure.
  waitUntil(
    Promise.allSettled([deliverResult(feature, outcome, reason, startedAt)]),
  );
}

function diagnosticLocations(error: unknown): readonly string[] {
  if (!(error instanceof Error)) {
    return [];
  }
  const header = `${error.name}: ${error.message}`;
  const stack = error.stack;
  if (!stack?.startsWith(header)) {
    return [];
  }
  // Remove the complete message, including any injected newlines, before
  // accepting bounded first-party frames from the engine-generated stack.
  return stack
    .slice(header.length)
    .split("\n")
    .flatMap((frame) => {
      const location =
        /^\s+at .+\/src\/((?:signals|lib)\/[a-zA-Z0-9_./-]+\.ts:\d+:\d+)\)?$/u.exec(
          frame,
        )?.[1];
      return location ? [location.slice(0, 240)] : [];
    })
    .slice(0, 5);
}

function diagnose(
  feature: AuxiliaryFeature,
  reason: Reason,
  error: unknown,
  context: Readonly<{ runId?: string; threadId?: string }> | undefined,
): void {
  log.warn("Auxiliary generation failed", {
    feature,
    reason,
    ...context,
    errorKind:
      error instanceof OpenRouterRequestError
        ? "openrouter_request"
        : error instanceof TypeError
          ? "type_error"
          : error instanceof SyntaxError
            ? "syntax_error"
            : "unknown",
    ...(error instanceof OpenRouterRequestError
      ? {
          status: error.status,
          errorCode: error.errorCode,
          errorParam: error.errorParam,
          errorType: error.errorType,
        }
      : {}),
    // Keep first-party source locations, without the error message, provider
    // payload, arbitrary file paths, or a raw stack in the diagnostic.
    locations: diagnosticLocations(error),
  });
}

/** Only generation and feature output interpretation belong inside this boundary. */
export async function generateAuxiliary<T>(
  args: {
    readonly feature: AuxiliaryFeature;
    readonly generate: () => Promise<T>;
    readonly usable: (value: T) => boolean;
    readonly diagnosticContext?: Readonly<{
      runId?: string;
      threadId?: string;
    }>;
  },
  signal?: AbortSignal,
): Promise<T | undefined> {
  const startedAt = now();
  const result = await settle(
    onRejection(
      (async () => {
        signal?.throwIfAborted();
        if (!isLlmConfigured()) {
          recordResult(args.feature, "skipped", "not_applicable", startedAt);
          return undefined;
        }
        const value = await args.generate();
        signal?.throwIfAborted();
        const usable = args.usable(value);
        if (!usable) {
          diagnose(
            args.feature,
            "invalid_output",
            undefined,
            args.diagnosticContext,
          );
        }
        recordResult(
          args.feature,
          usable ? "success" : "error",
          usable ? "none" : "invalid_output",
          startedAt,
        );
        return value;
      })(),
      (error) => {
        // A late, unrelated rejection must not be reclassified just because the
        // caller has since aborted. Preserve the exact cancellation reason.
        const cancelled = signal?.aborted === true && error === signal.reason;
        const reason = cancelled
          ? "caller_cancelled"
          : openRouterFailureReason(error);
        const outcome = cancelled
          ? "cancelled"
          : [
                "rate_limited",
                "upstream_timeout",
                "network",
                "provider_unavailable",
              ].includes(reason)
            ? "degraded"
            : "error";
        if (outcome === "error") {
          diagnose(args.feature, reason, error, args.diagnosticContext);
        }
        recordResult(args.feature, outcome, reason, startedAt);
      },
    ),
  );
  if (!result.ok) {
    if (signal?.aborted && result.error === signal.reason) {
      throw result.error;
    }
    return undefined;
  }
  return result.value;
}
