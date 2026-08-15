import { recordSandboxOperation } from "../external/sandbox-op-log";

type OrganizationQueueTerminalOutcome =
  | "cancelled"
  | "expired"
  | "claim_failed"
  | "missing_enqueue_boundary";

type OrganizationQueueFailureOutcome = "promotion_failed";

function organizationQueueDepthBucket(depth: number): string {
  if (depth <= 0) {
    return "0";
  }
  if (depth === 1) {
    return "1";
  }
  if (depth <= 3) {
    return "2_3";
  }
  if (depth <= 7) {
    return "4_7";
  }
  return "8_plus";
}

export function recordOrganizationQueueEnqueued(args: {
  readonly runId: string;
  readonly queueDepth: number;
  readonly timestamp: string;
}): void {
  recordSandboxOperation({
    sandboxType: "runner",
    actionType: "enqueue_zero_run",
    durationMs: 0,
    success: true,
    runId: args.runId,
    timestamp: args.timestamp,
    dimensions: {
      queue_depth_bucket: organizationQueueDepthBucket(args.queueDepth),
    },
  });
}

export function recordOrganizationQueueDequeued(args: {
  readonly runId: string;
  readonly queueWaitMs: number;
  readonly remainingQueueDepth: number;
  readonly timestamp: string;
}): void {
  recordSandboxOperation({
    sandboxType: "runner",
    actionType: "dequeue_zero_run",
    durationMs: Math.max(0, args.queueWaitMs),
    success: true,
    runId: args.runId,
    timestamp: args.timestamp,
    dimensions: {
      queue_depth_at_dequeue_bucket: organizationQueueDepthBucket(
        args.remainingQueueDepth,
      ),
    },
  });
}

export function recordOrganizationQueueTerminal(args: {
  readonly runId: string;
  readonly outcome: OrganizationQueueTerminalOutcome;
  readonly durationMs: number | undefined;
  readonly timestamp?: string;
}): void {
  recordSandboxOperation({
    sandboxType: "runner",
    actionType: "organization_queue_terminal",
    durationMs: Math.max(0, args.durationMs ?? 0),
    success: false,
    runId: args.runId,
    ...(args.timestamp ? { timestamp: args.timestamp } : {}),
    dimensions: {
      outcome: args.outcome,
    },
  });
}

export function recordOrganizationQueueFailure(args: {
  readonly runId: string;
  readonly outcome: OrganizationQueueFailureOutcome;
  readonly durationMs: number | undefined;
  readonly timestamp?: string;
}): void {
  recordSandboxOperation({
    sandboxType: "runner",
    actionType: "organization_queue_failure",
    durationMs: Math.max(0, args.durationMs ?? 0),
    success: false,
    runId: args.runId,
    ...(args.timestamp ? { timestamp: args.timestamp } : {}),
    dimensions: {
      outcome: args.outcome,
    },
  });
}
