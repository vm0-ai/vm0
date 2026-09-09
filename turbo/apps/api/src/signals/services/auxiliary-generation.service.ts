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
  openRouterFailureTokenCounts,
  type OpenRouterFailureReason,
  type OpenRouterTokenCounts,
} from "../external/openrouter-failure";
import { onRejection, safeSync, settle } from "../utils";

type AuxiliaryFeature =
  | "chat_title"
  | "shared_thread_title"
  | "run_summary"
  | "recommended_followups"
  | "notification_summary"
  | "goal_objective_brief";
type Outcome = "success" | "degraded" | "cancelled" | "error" | "skipped";
type Reason =
  | OpenRouterFailureReason
  | "none"
  | "caller_cancelled"
  | "not_applicable"
  // The provider returned well-formed text the feature itself cannot use.
  | "unusable_output";

/**
 * Provider-outcome detail the generation closure observes and the boundary
 * cannot infer from the returned value. Token counts are integers, so they
 * carry no payload risk while showing how much of the shared thinking-plus-
 * output budget a generation actually spent.
 */
interface AuxiliaryGenerationDetail {
  readonly truncated: boolean;
  readonly tokens: OpenRouterTokenCounts;
}

export type RecordAuxiliaryGenerationDetail = (
  detail: AuxiliaryGenerationDetail,
) => void;

interface AuxiliaryResult {
  readonly feature: AuxiliaryFeature;
  readonly outcome: Outcome;
  readonly reason: Reason;
  readonly tokens: OpenRouterTokenCounts;
  readonly startedAt: number;
}

/** Reasons the caller can do nothing about: counted, never warned. */
function isDegradedReason(reason: Reason): boolean {
  return (
    reason === "rate_limited" ||
    reason === "upstream_timeout" ||
    reason === "network" ||
    reason === "provider_unavailable" ||
    reason === "output_truncated" ||
    reason === "unexpected_tool_calls"
  );
}

const log = logger("api:auxiliary-generation");

async function deliverResult(result: AuxiliaryResult): Promise<void> {
  const elapsed = now() - result.startedAt;
  const ingested = safeSync(() => {
    return ingestToAxiom(getDatasetName("web-logs"), [
      {
        _time: nowDate().toISOString(),
        type: "auxiliary_generation_result",
        source: "api",
        feature: result.feature,
        outcome: result.outcome,
        reason: result.reason,
        duration_ms: Number.isFinite(elapsed)
          ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, elapsed))
          : 0,
        ...(result.tokens.completionTokens === undefined
          ? {}
          : { completion_tokens: result.tokens.completionTokens }),
        ...(result.tokens.reasoningTokens === undefined
          ? {}
          : { reasoning_tokens: result.tokens.reasoningTokens }),
      },
    ]);
  });
  if ("ok" in ingested && ingested.ok) {
    await flushAxiom({ client: "telemetry" });
  }
}

function recordResult(result: AuxiliaryResult): void {
  // A title/callback may finish after the response's flush. Register its own
  // flush with the same request lifetime; exporter failure is never business failure.
  waitUntil(Promise.allSettled([deliverResult(result)]));
}

/**
 * The finite reason and error kind carry the whole signal. This deliberately
 * reports no source locations: production runs a bundle whose frames are
 * `file:///var/task/index.js:...`, so a first-party stack filter matched
 * nothing there while remaining a standing risk of admitting a provider
 * message or a file path into the diagnostic.
 */
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
  });
}

/** Only generation and feature output interpretation belong inside this boundary. */
export async function generateAuxiliary<T>(
  args: {
    readonly feature: AuxiliaryFeature;
    readonly generate: (record: RecordAuxiliaryGenerationDetail) => Promise<T>;
    readonly usable: (value: T) => boolean;
    readonly diagnosticContext?: Readonly<{
      runId?: string;
      threadId?: string;
    }>;
  },
  signal?: AbortSignal,
): Promise<T | undefined> {
  const startedAt = now();
  let detail: AuxiliaryGenerationDetail | undefined;
  const result = await settle(
    onRejection(
      (async () => {
        signal?.throwIfAborted();
        if (!isLlmConfigured()) {
          recordResult({
            feature: args.feature,
            outcome: "skipped",
            reason: "not_applicable",
            tokens: {},
            startedAt,
          });
          return undefined;
        }
        const value = await args.generate((reported) => {
          detail = reported;
        });
        signal?.throwIfAborted();
        const usable = args.usable(value);
        // Truncation classifies first even when the shortened text turns out to
        // be unusable: the token ceiling is the known, non-actionable cause, and
        // reporting it as a defect would restore the noise this replaces.
        const truncated = detail?.truncated === true;
        const outcome = truncated ? "degraded" : usable ? "success" : "error";
        if (outcome === "error") {
          diagnose(
            args.feature,
            "unusable_output",
            undefined,
            args.diagnosticContext,
          );
        }
        recordResult({
          feature: args.feature,
          outcome,
          reason: truncated
            ? "output_truncated"
            : usable
              ? "none"
              : "unusable_output",
          tokens: detail?.tokens ?? {},
          startedAt,
        });
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
          : isDegradedReason(reason)
            ? "degraded"
            : "error";
        if (outcome === "error") {
          diagnose(args.feature, reason, error, args.diagnosticContext);
        }
        recordResult({
          feature: args.feature,
          outcome,
          reason,
          tokens: openRouterFailureTokenCounts(error),
          startedAt,
        });
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
