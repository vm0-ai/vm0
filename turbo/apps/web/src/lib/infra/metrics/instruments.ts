import { ingestSandboxOpLog } from "../../shared/axiom";

export function recordSandboxOperation(attrs: {
  sandboxType: "runner" | "docker" | "chat";
  actionType: string;
  durationMs: number;
  success: boolean;
  runId: string;
  dimensions?: Record<string, unknown>;
}): void {
  ingestSandboxOpLog({
    source: "web",
    op_type: attrs.actionType,
    sandbox_type: attrs.sandboxType,
    duration_ms: attrs.durationMs,
    run_id: attrs.runId,
    ...attrs.dimensions,
  });
}

export function recordSandboxInternalOperation(attrs: {
  actionType: string;
  sandboxType: string;
  durationMs: number;
  success: boolean;
  runId: string;
}): void {
  ingestSandboxOpLog({
    source: "sandbox",
    op_type: attrs.actionType,
    sandbox_type: attrs.sandboxType,
    duration_ms: attrs.durationMs,
    run_id: attrs.runId,
  });
}

export interface ChatSpanDimensions {
  run_id?: string | null;
  org_id?: string | null;
  user_id?: string;
  agent_id?: string;
  thread_id?: string;
  token_type?: string;
  model_selection_present?: boolean;
  thread_length?: number;
  thread_is_new?: boolean;
  /**
   * "claims" when Round 1 used Clerk session claims to build user info,
   * "cache" when it fell back to `getCachedUser`. Lets Axiom split the
   * `create_run_round1_cached_user` span by source to measure short-circuit
   * hit rate after rollout.
   */
  user_info_source?: "claims" | "cache";
}

/**
 * Emit a Phase-1 chat request span to the shared `sandbox-op-log` dataset
 * with `source: "web-chat"`. sandbox_type has no meaning for chat spans —
 * we fill `"chat"` for schema consistency. `run_id` is absent until the
 * run-record transaction commits and is therefore optional on the entry.
 */
export function recordChatSpan(
  opType: string,
  durationMs: number,
  dims: ChatSpanDimensions,
): void {
  const { run_id: runId, ...rest } = dims;
  ingestSandboxOpLog({
    source: "web-chat",
    op_type: opType,
    sandbox_type: "chat",
    duration_ms: durationMs,
    ...(runId ? { run_id: runId } : {}),
    ...rest,
  });
}
