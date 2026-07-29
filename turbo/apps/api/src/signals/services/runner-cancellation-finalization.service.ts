import type { AgentRunCancellationFinalizationStatus } from "@vm0/db/schema/agent-run";

export const CANCELLATION_FINALIZATION_SUPPORTED =
  "supported" satisfies AgentRunCancellationFinalizationStatus;
export const CANCELLATION_FINALIZATION_PENDING =
  "pending" satisfies AgentRunCancellationFinalizationStatus;
export const CANCELLATION_FINALIZATION_FINALIZED =
  "finalized" satisfies AgentRunCancellationFinalizationStatus;
export const CANCELLATION_FINALIZATION_STALE_MS = 10 * 60 * 1000;

export function cancellationFinalizationRequired(run: {
  readonly status: string;
  readonly cancellationFinalizationStatus: AgentRunCancellationFinalizationStatus | null;
}): boolean {
  return (
    run.status === "cancelled" &&
    run.cancellationFinalizationStatus !== null &&
    run.cancellationFinalizationStatus !== CANCELLATION_FINALIZATION_FINALIZED
  );
}
