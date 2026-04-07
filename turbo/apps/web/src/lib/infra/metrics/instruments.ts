import { ingestSandboxOpLog } from "../../shared/axiom";

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
