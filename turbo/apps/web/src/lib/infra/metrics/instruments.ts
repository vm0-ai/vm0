import { ingestSandboxOpLog, ingestChatRequestSpan } from "../../shared/axiom";

export function recordSandboxOperation(attrs: {
  sandboxType: "runner" | "docker";
  actionType: string;
  durationMs: number;
  success: boolean;
  runId: string;
}): void {
  ingestSandboxOpLog({
    source: "web",
    op_type: attrs.actionType,
    sandbox_type: attrs.sandboxType,
    duration_ms: attrs.durationMs,
    run_id: attrs.runId,
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
}

export function recordChatSpan(
  opType: string,
  durationMs: number,
  dims: ChatSpanDimensions,
): void {
  ingestChatRequestSpan({
    op_type: opType,
    duration_ms: durationMs,
    ...dims,
  });
}
