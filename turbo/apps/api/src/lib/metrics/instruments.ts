import { ingestSandboxOpLog } from "../axiom";

export function recordSandboxOperation(attrs: {
  sandboxType: "runner" | "e2b";
  actionType: string;
  durationMs: number;
  success: boolean;
}): void {
  ingestSandboxOpLog({
    source: "web",
    op_type: attrs.actionType,
    sandbox_type: attrs.sandboxType,
    duration_ms: attrs.durationMs,
  });
}

export function recordSandboxInternalOperation(attrs: {
  actionType: string;
  sandboxType: string;
  durationMs: number;
  success: boolean;
}): void {
  ingestSandboxOpLog({
    source: "sandbox",
    op_type: attrs.actionType,
    sandbox_type: attrs.sandboxType,
    duration_ms: attrs.durationMs,
  });
}
