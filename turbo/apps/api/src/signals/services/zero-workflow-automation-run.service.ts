import { randomBytes } from "node:crypto";

import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { zeroWorkflowAutomations } from "@vm0/db/schema/zero-workflow";
import { command } from "ccstate";
import { eq } from "drizzle-orm";

import { writeDb$, type Db } from "../external/db";
import { publishChatThreadWorkflowQueueChangedSafely } from "../external/realtime";
import { now, nowDate } from "../external/time";
import type {
  BeforeRunDispatch,
  DispatchFailedRunCallbacks,
} from "./agent-run-create.service";
import type { InternalRunCallbackKind } from "./internal-run-callback";
import {
  postRunUserMessage,
  publishRunUserMessageSignals,
  resolveRunChatThreadModelPin,
} from "./zero-chat-run-message.service";
import {
  resolveModelFirstProviderAdmission,
  type ModelFirstPin,
} from "./zero-model-selection.service";
import {
  admitWorkflowAutomationEvent,
  claimWorkflowQueueEventForRun,
  discardWorkflowQueueEvent,
  pauseWorkflowQueueEvent,
  type WorkflowQueueEvent,
} from "./chat-message-queue.service";
import {
  ApiDispatchTimingCollector,
  measureApiDispatchTiming,
} from "./api-dispatch-timing.service";
import { createZeroRun$ } from "./zero-runs-create.service";
import { workflowAutomationCanFire } from "./zero-workflow-automation-access.service";

export type AutomationRow = typeof zeroWorkflowAutomations.$inferSelect;

export interface DueWorkflowAutomation {
  readonly automation: AutomationRow;
  // The owning agent is derived from the workflow row (hard 1:N); automations no
  // longer carry an agentId column, so callers resolve it and pass it here.
  readonly agentId: string;
  readonly workflowName: string;
  readonly chatThreadId: string;
  // One-time schedule automations are disabled as part of the optimistic claim.
  // That claimed row can still proceed through the run-start readability gate.
  readonly allowClaimedOnceScheduleAutomation?: boolean;
}

type RunErrorResponse = {
  readonly status: number;
  readonly body: {
    readonly error: { readonly message: string; readonly code: string };
  };
};

export type RunWorkflowAutomationResult =
  | { readonly kind: "ok"; readonly runId: string }
  // The event was accepted into the workflow queue instead of starting a run.
  | { readonly kind: "enqueued" }
  | { readonly kind: "conflict"; readonly message: string }
  | { readonly kind: "run_error"; readonly response: RunErrorResponse };

export type RunFailure = Exclude<
  RunWorkflowAutomationResult,
  { kind: "ok" } | { kind: "enqueued" }
>;
type RunConflict = Extract<RunFailure, { readonly kind: "conflict" }>;
type ActivePreviousRunPolicy = "block" | "allow";

interface InternalRunCallbackInput {
  readonly internalKind: InternalRunCallbackKind;
  readonly secret: string;
  readonly payload: unknown;
}

type ModelContext =
  | {
      readonly ok: true;
      readonly modelPin: ModelFirstPin;
      readonly effectiveModelProvider: string | null | undefined;
    }
  | { readonly ok: false; readonly failure: RunFailure };

export interface RunWorkflowAutomationNowArgs {
  readonly due: DueWorkflowAutomation;
  readonly apiStartTime: number;
  readonly sessionId?: string;
  // Overrides the default `/<workflowName>` slash-command prompt.
  readonly prompt?: string;
  // Display-only source context surfaced through workflowSnapshot.triggerBrief.
  readonly triggerBrief?: string;
  readonly triggerSource?: TriggerSource;
  readonly appendSystemPrompt?: string;
  readonly callbacks?: readonly InternalRunCallbackInput[];
  readonly activePreviousRunPolicy?: ActivePreviousRunPolicy;
  // Set by the queue drain (and manual "Run now"): skip workflow-queue
  // admission and always create the run.
  readonly bypassWorkflowQueue?: boolean;
  // Set by the queue drain. The run must claim this exact event before runner
  // queue persistence; manual queue bypasses leave it undefined.
  readonly workflowQueueEvent?: WorkflowQueueEvent;
  readonly recordLastRunId?: boolean;
  readonly recordLastRunAt?: boolean;
  readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
  readonly timing?: ApiDispatchTimingCollector;
}

interface WorkflowAutomationRunInput {
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly callbacks: readonly InternalRunCallbackInput[];
  readonly zeroRunMetadata: ReturnType<typeof workflowAutomationRunMetadata>;
}

type WorkflowQueueClaimState = "pending" | "claimed" | "lost";

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

function isActivePreviousRunStatus(status: string): boolean {
  return status === "pending" || status === "running";
}

function workflowAutomationRunMetadata(
  automation: AutomationRow,
  triggerBrief: string | undefined,
) {
  return {
    workflowAutomationId: automation.id,
    triggerBrief,
    // The automation id is the run group id: all runs fired by the same automation
    // share a group for chat folding and carry the same row-level association.
    runGroupId: automation.id,
  };
}

/**
 * The recurrence reschedule callback (advances `next_run_at` / failure
 * bookkeeping on completion) plus the chat callback (drives the web-chat
 * render). Cron and once both use the cron callback; once carries no
 * cronExpression so it does not recur.
 */
function buildWorkflowAutomationCallbacks(
  automation: AutomationRow,
  agentId: string,
  chatThreadId: string,
): InternalRunCallbackInput[] {
  const callbacks: InternalRunCallbackInput[] = [];
  if (automation.scheduleType === "loop") {
    callbacks.push({
      internalKind: "workflow-automation:loop",
      secret: generateCallbackSecret(),
      payload: {
        automationId: automation.id,
      },
    });
  } else {
    callbacks.push({
      internalKind: "workflow-automation:cron",
      secret: generateCallbackSecret(),
      payload: {
        automationId: automation.id,
        timezone: automation.timezone,
        ...(automation.cronExpression
          ? { cronExpression: automation.cronExpression }
          : {}),
      },
    });
  }
  callbacks.push({
    internalKind: "chat",
    secret: generateCallbackSecret(),
    payload: { threadId: chatThreadId, agentId },
  });
  return callbacks;
}

function buildAppendSystemPrompt(workflowName: string): string {
  return [
    "# Current context",
    `You are running on a schedule for the "${workflowName}" workflow.`,
    "The workflow's procedure is available as a skill - execute it now.",
    "This run is linked to a web chat thread; everything you output is shown to the user there.",
    "Connector permissions use the same agent-run permission settings as chat runs. If a connector request fails, do not retry blindly or assume an HTTP error came from Zero permission policy. Run `zero connector check --url <FAILED_URL> --method <METHOD> [--connector <connector-ref>]`; only when it reports a deny or ask outcome, request access with `zero connector permission-request <connector-ref> --permission <name>` and tell the user which permission this automation needs. The user chooses the grant duration in the confirmation UI. Omit query strings or fragments when they may contain secrets because permission matching does not need them.",
  ].join("\n");
}

export function buildChatOnlyWorkflowAutomationCallbacks(
  chatThreadId: string,
  agentId: string,
): InternalRunCallbackInput[] {
  return [
    {
      internalKind: "chat",
      secret: generateCallbackSecret(),
      payload: {
        threadId: chatThreadId,
        agentId,
      },
    },
  ];
}

async function resolveModelContext(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string;
  readonly signal: AbortSignal;
}): Promise<ModelContext> {
  const threadModelPin = await resolveRunChatThreadModelPin({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    threadId: args.chatThreadId,
  });
  args.signal.throwIfAborted();
  if ("status" in threadModelPin) {
    return {
      ok: false,
      failure: {
        kind: "run_error",
        response: { status: 400, body: threadModelPin.body },
      },
    };
  }

  const providerAdmission = await resolveModelFirstProviderAdmission({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    modelPin: threadModelPin,
    requestedModelProvider: undefined,
  });
  args.signal.throwIfAborted();
  if (providerAdmission.error) {
    return {
      ok: false,
      failure: { kind: "run_error", response: providerAdmission.error },
    };
  }

  return {
    ok: true,
    modelPin: threadModelPin,
    effectiveModelProvider: providerAdmission.effectiveModelProvider,
  };
}

function workflowAutomationTiming(
  args: RunWorkflowAutomationNowArgs,
): ApiDispatchTimingCollector {
  const timing = args.timing ?? new ApiDispatchTimingCollector();
  if (!args.timing) {
    timing.recordElapsed(
      "api_dispatch_pre_create_zero_workflow_automation_entrypoint_gap",
      "nested",
      args.apiStartTime,
    );
  }
  return timing;
}

async function checkActivePreviousWorkflowRun(args: {
  readonly db: Db;
  readonly automation: AutomationRow;
  readonly activePreviousRunPolicy?: ActivePreviousRunPolicy;
  readonly timing: ApiDispatchTimingCollector;
  readonly signal: AbortSignal;
}): Promise<RunFailure | undefined> {
  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_zero_workflow_automation_check_active_run",
    "nested",
    async (): Promise<RunFailure | undefined> => {
      if (
        args.activePreviousRunPolicy !== "allow" &&
        args.automation.lastRunId
      ) {
        const [lastRun] = await args.db
          .select({ status: agentRuns.status })
          .from(agentRuns)
          .where(eq(agentRuns.id, args.automation.lastRunId))
          .limit(1);
        args.signal.throwIfAborted();
        if (lastRun && isActivePreviousRunStatus(lastRun.status)) {
          return {
            kind: "conflict",
            message: "Previous run is still active",
          };
        }
      }
      return undefined;
    },
  );
}

async function checkWorkflowAutomationTargetReadable(args: {
  readonly db: Db;
  readonly automation: AutomationRow;
  readonly agentId: string;
  readonly allowClaimedOnceScheduleAutomation: boolean;
  readonly timing: ApiDispatchTimingCollector;
  readonly signal: AbortSignal;
}): Promise<RunConflict | undefined> {
  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_zero_workflow_automation_check_target_access",
    "nested",
    async (): Promise<RunConflict | undefined> => {
      const canFire = await workflowAutomationCanFire(args.db, {
        automation: args.automation,
        agentId: args.agentId,
        allowClaimedOnceScheduleAutomation:
          args.allowClaimedOnceScheduleAutomation,
        signal: args.signal,
      });
      args.signal.throwIfAborted();
      if (!canFire) {
        return {
          kind: "conflict",
          message: "Workflow automation is paused or no longer readable",
        };
      }
      return undefined;
    },
  );
}

async function resolveTimedWorkflowModelContext(args: {
  readonly db: Db;
  readonly automation: AutomationRow;
  readonly chatThreadId: string;
  readonly timing: ApiDispatchTimingCollector;
  readonly signal: AbortSignal;
}): Promise<ModelContext> {
  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_zero_workflow_automation_resolve_model_context",
    "nested",
    async () => {
      return await resolveModelContext({
        db: args.db,
        orgId: args.automation.orgId,
        userId: args.automation.ownerUserId,
        chatThreadId: args.chatThreadId,
        signal: args.signal,
      });
    },
  );
}

async function buildTimedWorkflowAutomationRunInput(args: {
  readonly command: RunWorkflowAutomationNowArgs;
  readonly automation: AutomationRow;
  readonly agentId: string;
  readonly workflowName: string;
  readonly chatThreadId: string;
  readonly timing: ApiDispatchTimingCollector;
}): Promise<WorkflowAutomationRunInput> {
  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_zero_workflow_automation_build_run_input",
    "nested",
    () => {
      return {
        prompt: args.command.prompt ?? `/${args.workflowName}`,
        appendSystemPrompt:
          args.command.appendSystemPrompt ??
          buildAppendSystemPrompt(args.workflowName),
        callbacks:
          args.command.callbacks ??
          buildWorkflowAutomationCallbacks(
            args.automation,
            args.agentId,
            args.chatThreadId,
          ),
        zeroRunMetadata: workflowAutomationRunMetadata(
          args.automation,
          args.command.triggerBrief,
        ),
      };
    },
  );
}

function callbackPayloadRecord(
  payload: unknown,
): payload is Readonly<Record<string, unknown>> {
  return (
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
  );
}

function markWorkflowQueueCandidateCallbacks(
  callbacks: readonly InternalRunCallbackInput[],
  eventId: string,
): readonly InternalRunCallbackInput[] {
  let marked = false;
  const result = callbacks.map((callback) => {
    if (callback.internalKind !== "chat") {
      return callback;
    }
    if (!callbackPayloadRecord(callback.payload)) {
      throw new Error("Workflow chat callback payload must be an object");
    }
    marked = true;
    return {
      ...callback,
      payload: {
        ...callback.payload,
        workflowQueueEventId: eventId,
      },
    };
  });
  if (!marked) {
    throw new Error("Workflow queue candidate requires a chat callback");
  }
  return result;
}

type WorkflowQueuePreparation =
  | {
      readonly kind: "run";
      readonly event: WorkflowQueueEvent | undefined;
    }
  | { readonly kind: "enqueued" };

interface PreparedWorkflowAutomationRun {
  readonly runInput: WorkflowAutomationRunInput;
  readonly modelPin: ModelFirstPin;
  readonly effectiveModelProvider: string | null | undefined;
}

type WorkflowAutomationPreparation =
  | {
      readonly kind: "ready";
      readonly prepared: PreparedWorkflowAutomationRun;
    }
  | {
      readonly kind: "complete";
      readonly result: RunWorkflowAutomationResult;
    };

/** Persist automated intake before allowing its new FIFO head to prepare. */
async function prepareWorkflowQueueEvent(input: {
  readonly db: Db;
  readonly args: RunWorkflowAutomationNowArgs;
  readonly signal: AbortSignal;
}): Promise<WorkflowQueuePreparation> {
  const { db, args, signal } = input;
  const { automation, chatThreadId } = args.due;
  if (args.bypassWorkflowQueue === true) {
    return { kind: "run", event: args.workflowQueueEvent };
  }
  if (args.workflowQueueEvent) {
    throw new Error("Workflow queue event requires queue-admission bypass");
  }
  const admission = await admitWorkflowAutomationEvent(db, {
    automation,
    chatThreadId,
    triggerSource: args.triggerSource ?? "workflow-schedule",
    triggerBrief: args.triggerBrief,
    params: {
      version: 1,
      prompt: args.prompt,
      appendSystemPrompt: args.appendSystemPrompt,
      callbacks: args.callbacks,
      recordLastRunId: args.recordLastRunId,
      recordLastRunAt: args.recordLastRunAt,
    },
  });
  signal.throwIfAborted();
  await publishChatThreadWorkflowQueueChangedSafely(
    automation.ownerUserId,
    chatThreadId,
  );
  signal.throwIfAborted();
  if (admission.kind === "enqueued") {
    return { kind: "enqueued" };
  }
  return { kind: "run", event: admission.event };
}

async function prepareWorkflowAutomationRun(input: {
  readonly db: Db;
  readonly args: RunWorkflowAutomationNowArgs;
  readonly queueEvent: WorkflowQueueEvent | undefined;
  readonly timing: ApiDispatchTimingCollector;
  readonly signal: AbortSignal;
}): Promise<WorkflowAutomationPreparation> {
  const { db, args, queueEvent, timing, signal } = input;
  const { automation, agentId, workflowName, chatThreadId } = args.due;
  const activePreviousRunFailure = await checkActivePreviousWorkflowRun({
    db,
    automation,
    activePreviousRunPolicy: args.activePreviousRunPolicy,
    timing,
    signal,
  });
  if (activePreviousRunFailure) {
    return {
      kind: "complete",
      result: queueEvent ? { kind: "enqueued" } : activePreviousRunFailure,
    };
  }

  const targetAccessFailure = await checkWorkflowAutomationTargetReadable({
    db,
    automation,
    agentId,
    allowClaimedOnceScheduleAutomation:
      args.due.allowClaimedOnceScheduleAutomation === true,
    timing,
    signal,
  });
  if (targetAccessFailure) {
    const result = queueEvent
      ? await discardUnfireableWorkflowQueueEvent({
          db,
          event: queueEvent,
          failure: targetAccessFailure,
          signal,
        })
      : targetAccessFailure;
    return { kind: "complete", result };
  }

  const modelContext = await resolveTimedWorkflowModelContext({
    db,
    automation,
    chatThreadId,
    timing,
    signal,
  });
  if (!modelContext.ok) {
    const result =
      queueEvent && modelContext.failure.kind === "run_error"
        ? await preserveWorkflowQueueEventAfterFailure({
            db,
            event: queueEvent,
            response: modelContext.failure.response,
            signal,
          })
        : modelContext.failure;
    return { kind: "complete", result };
  }

  const runInput = await buildTimedWorkflowAutomationRunInput({
    command: args,
    automation,
    agentId,
    workflowName,
    chatThreadId,
    timing,
  });
  signal.throwIfAborted();
  return {
    kind: "ready",
    prepared: {
      runInput,
      modelPin: modelContext.modelPin,
      effectiveModelProvider: modelContext.effectiveModelProvider,
    },
  };
}

async function recordWorkflowAutomationRunStart(input: {
  readonly db: Db;
  readonly args: RunWorkflowAutomationNowArgs;
  readonly runId: string;
  readonly runStatus: string;
  readonly prompt: string;
  readonly modelPin: ModelFirstPin;
  readonly effectiveModelProvider: string | null | undefined;
  readonly queueEvent: WorkflowQueueEvent | undefined;
  readonly signal: AbortSignal;
}): Promise<void> {
  const { db, args, runId, signal } = input;
  const { automation, chatThreadId } = args.due;
  if (input.queueEvent) {
    await publishRunUserMessageSignals(automation.ownerUserId, chatThreadId);
    await publishChatThreadWorkflowQueueChangedSafely(
      automation.ownerUserId,
      chatThreadId,
    );
  } else {
    await postRunUserMessage({
      db,
      threadId: chatThreadId,
      userId: automation.ownerUserId,
      runId,
      prompt: input.prompt,
      appendQueueMarker: input.runStatus === "queued",
      runGroupId: automation.id,
    });
  }
  signal.throwIfAborted();

  await db
    .update(zeroRuns)
    .set({
      modelProvider: input.effectiveModelProvider,
      modelProviderId: input.modelPin.modelProviderId,
      modelProviderCredentialScope: input.modelPin.modelProviderCredentialScope,
      selectedModel: input.modelPin.selectedModel,
    })
    .where(eq(zeroRuns.id, runId));
  signal.throwIfAborted();

  await db
    .update(zeroWorkflowAutomations)
    .set({
      ...(args.recordLastRunId === false ? {} : { lastRunId: runId }),
      ...(args.recordLastRunAt ? { lastRunAt: nowDate() } : {}),
      updatedAt: nowDate(),
    })
    .where(eq(zeroWorkflowAutomations.id, automation.id));
  signal.throwIfAborted();
}

async function preserveWorkflowQueueEventAfterFailure(input: {
  readonly db: Db;
  readonly event: WorkflowQueueEvent;
  readonly response: RunErrorResponse;
  readonly signal: AbortSignal;
}): Promise<RunWorkflowAutomationResult> {
  const pausedAt = nowDate();
  const paused = await pauseWorkflowQueueEvent(input.db, {
    event: input.event,
    pauseReason: input.response.body.error.message,
    pausedAt,
  });
  input.signal.throwIfAborted();
  if (paused) {
    await publishChatThreadWorkflowQueueChangedSafely(
      input.event.userId,
      input.event.chatThreadId,
    );
    input.signal.throwIfAborted();
  }
  return { kind: "enqueued" };
}

async function discardUnfireableWorkflowQueueEvent(input: {
  readonly db: Db;
  readonly event: WorkflowQueueEvent;
  readonly failure: RunConflict;
  readonly signal: AbortSignal;
}): Promise<RunWorkflowAutomationResult> {
  const discarded = await discardWorkflowQueueEvent(input.db, input.event);
  input.signal.throwIfAborted();
  if (!discarded) {
    return { kind: "enqueued" };
  }
  await publishChatThreadWorkflowQueueChangedSafely(
    input.event.userId,
    input.event.chatThreadId,
  );
  input.signal.throwIfAborted();
  return input.failure;
}

function workflowQueueClaimFailureResponse(
  error: string | undefined,
): RunErrorResponse {
  return {
    status: 500,
    body: {
      error: {
        message: error ?? "Workflow queue ownership claim failed",
        code: "INTERNAL_ERROR",
      },
    },
  };
}

export const runWorkflowAutomationNow$ = command(
  async (
    { set },
    args: RunWorkflowAutomationNowArgs,
    signal: AbortSignal,
  ): Promise<RunWorkflowAutomationResult> => {
    const db = set(writeDb$);
    const { automation, agentId, chatThreadId } = args.due;
    const timing = workflowAutomationTiming(args);

    const queuePreparation = await prepareWorkflowQueueEvent({
      db,
      args,
      signal,
    });
    if (queuePreparation.kind === "enqueued") {
      return { kind: "enqueued" };
    }
    const queueEvent = queuePreparation.event;

    const preparation = await prepareWorkflowAutomationRun({
      db,
      args,
      queueEvent,
      timing,
      signal,
    });
    if (preparation.kind === "complete") {
      return preparation.result;
    }
    const { runInput, modelPin, effectiveModelProvider } = preparation.prepared;
    const callbacks = queueEvent
      ? markWorkflowQueueCandidateCallbacks(runInput.callbacks, queueEvent.id)
      : runInput.callbacks;
    const queueClaimState: { current: WorkflowQueueClaimState } = {
      current: "pending",
    };
    const beforeDispatch: BeforeRunDispatch | undefined = queueEvent
      ? async ({ runId }) => {
          const claimed = await claimWorkflowQueueEventForRun(db, {
            event: queueEvent,
            runId,
            prompt: runInput.prompt,
          });
          queueClaimState.current = claimed ? "claimed" : "lost";
          return claimed;
        }
      : undefined;
    timing.recordElapsed(
      "api_dispatch_pre_create_zero_workflow_automation_create_run",
      "nested",
      now(),
    );
    const result = await set(
      createZeroRun$,
      {
        auth: {
          orgId: automation.orgId,
          orgRole: "member",
          userId: automation.ownerUserId,
          tokenType: "session",
        },
        body: {
          prompt: runInput.prompt,
          agentId,
          ...(args.sessionId ? { sessionId: args.sessionId } : {}),
          ...(effectiveModelProvider
            ? { modelProvider: effectiveModelProvider }
            : {}),
        },
        apiStartTime: args.apiStartTime,
        triggerSource: args.triggerSource ?? "workflow-schedule",
        chatThreadId,
        modelProviderId: modelPin.modelProviderId ?? undefined,
        modelProviderCredentialScope:
          modelPin.modelProviderCredentialScope ?? undefined,
        selectedModelOverride: modelPin.selectedModel ?? undefined,
        appendSystemPrompt: runInput.appendSystemPrompt,
        callbacks,
        zeroRunMetadata: runInput.zeroRunMetadata,
        dispatchFailedCallbacks: args.dispatchFailedCallbacks,
        beforeDispatch,
        timing,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status !== 201) {
      if (queueEvent) {
        return await preserveWorkflowQueueEventAfterFailure({
          db,
          event: queueEvent,
          response: result,
          signal,
        });
      }
      return { kind: "run_error", response: result };
    }
    if (queueEvent && queueClaimState.current === "lost") {
      return { kind: "enqueued" };
    }
    if (queueEvent && queueClaimState.current === "pending") {
      return await preserveWorkflowQueueEventAfterFailure({
        db,
        event: queueEvent,
        response: workflowQueueClaimFailureResponse(result.body.error),
        signal,
      });
    }

    await recordWorkflowAutomationRunStart({
      db,
      args,
      runId: result.body.runId,
      runStatus: result.body.status,
      prompt: runInput.prompt,
      modelPin,
      effectiveModelProvider,
      queueEvent,
      signal,
    });

    return { kind: "ok", runId: result.body.runId };
  },
);
