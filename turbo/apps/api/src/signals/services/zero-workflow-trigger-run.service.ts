import { randomBytes } from "node:crypto";

import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { zeroWorkflowTriggers } from "@vm0/db/schema/zero-workflow";
import { command, type Computed } from "ccstate";
import { eq } from "drizzle-orm";

import { writeDb$, type Db } from "../external/db";
import { publishChatThreadWorkflowQueueChangedSafely } from "../external/realtime";
import { now, nowDate } from "../external/time";
import type { DispatchFailedRunCallbacks } from "./agent-run-create.service";
import type { InternalRunCallbackKind } from "./internal-run-callback";
import {
  postRunUserMessage,
  resolveRunChatThreadModelPin,
} from "./zero-chat-run-message.service";
import {
  resolveModelFirstProviderAdmission,
  type ModelFirstPin,
} from "./zero-model-selection.service";
import {
  ApiDispatchTimingCollector,
  measureApiDispatchTiming,
} from "./api-dispatch-timing.service";
import { createZeroRun$ } from "./zero-runs-create.service";
import { userFeatureSwitchOverrides } from "./feature-switches.service";
import {
  admitWorkflowTriggerEvent,
  workflowQueueEnabledForOwner,
} from "./chat-message-queue.service";
import { workflowTriggerCanFire } from "./zero-workflow-trigger-access.service";

export type TriggerRow = typeof zeroWorkflowTriggers.$inferSelect;

export interface DueWorkflowTrigger {
  readonly trigger: TriggerRow;
  // The owning agent is derived from the workflow row (hard 1:N); triggers no
  // longer carry an agentId column, so callers resolve it and pass it here.
  readonly agentId: string;
  readonly workflowName: string;
  readonly chatThreadId: string;
  // One-time schedule triggers are disabled as part of the optimistic claim.
  // That claimed row can still proceed through the run-start readability gate.
  readonly allowClaimedOnceScheduleTrigger?: boolean;
}

type RunErrorResponse = {
  readonly status: number;
  readonly body: {
    readonly error: { readonly message: string; readonly code: string };
  };
};

export type RunWorkflowTriggerResult =
  | { readonly kind: "ok"; readonly runId: string }
  // The event was accepted into the workflow queue instead of starting a run.
  | { readonly kind: "enqueued" }
  | { readonly kind: "conflict"; readonly message: string }
  | { readonly kind: "run_error"; readonly response: RunErrorResponse };

export type RunFailure = Exclude<
  RunWorkflowTriggerResult,
  { kind: "ok" } | { kind: "enqueued" }
>;
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

export interface RunWorkflowTriggerNowArgs {
  readonly due: DueWorkflowTrigger;
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
  readonly recordLastRunId?: boolean;
  readonly recordLastRunAt?: boolean;
  readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
  readonly timing?: ApiDispatchTimingCollector;
}

interface WorkflowTriggerRunInput {
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly callbacks: readonly InternalRunCallbackInput[];
  readonly zeroRunMetadata: ReturnType<typeof workflowTriggerRunMetadata>;
  readonly memoryEmbeddingWorkflowTriggerId?: string;
}

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

function isActivePreviousRunStatus(status: string): boolean {
  return status === "pending" || status === "running";
}

function workflowTriggerRunMetadata(
  trigger: TriggerRow,
  triggerBrief: string | undefined,
) {
  return {
    workflowTriggerId: trigger.id,
    triggerBrief,
    // The trigger id is the run group id: all runs fired by the same trigger
    // share a group for chat folding, and `zero_runs.workflow_trigger_id`
    // already carries the same value as a row-level reference.
    runGroupId: trigger.id,
  };
}

/**
 * The recurrence reschedule callback (advances `next_run_at` / failure
 * bookkeeping on completion) plus the chat callback (drives the web-chat
 * render). Cron and once both use the cron callback; once carries no
 * cronExpression so it does not recur.
 */
function buildWorkflowTriggerCallbacks(
  trigger: TriggerRow,
  agentId: string,
  chatThreadId: string,
): InternalRunCallbackInput[] {
  const callbacks: InternalRunCallbackInput[] = [];
  if (trigger.scheduleType === "loop") {
    callbacks.push({
      internalKind: "workflow-automation:loop",
      secret: generateCallbackSecret(),
      payload: { triggerId: trigger.id },
    });
  } else {
    callbacks.push({
      internalKind: "workflow-automation:cron",
      secret: generateCallbackSecret(),
      payload: {
        triggerId: trigger.id,
        timezone: trigger.timezone,
        ...(trigger.cronExpression
          ? { cronExpression: trigger.cronExpression }
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
    `You are running on a schedule trigger for the "${workflowName}" workflow.`,
    "The workflow's procedure is available as a skill - execute it now.",
    "This run is linked to a web chat thread; everything you output is shown to the user there.",
    "Connector permissions use the same agent-run permission settings as chat runs. If a request is denied by a permission, do not retry blindly - run `zero doctor permission-deny <connector-ref> --method <METHOD> --url <DENIED_URL>` to identify the permission, then tell the user which permission this automation needs. Use the `url` field from the firewall denial response when present; omit query strings or fragments when they may contain secrets because permission matching does not need them.",
  ].join("\n");
}

export function buildChatOnlyWorkflowTriggerCallbacks(
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

function workflowTriggerTiming(
  args: RunWorkflowTriggerNowArgs,
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
  readonly trigger: TriggerRow;
  readonly activePreviousRunPolicy?: ActivePreviousRunPolicy;
  readonly timing: ApiDispatchTimingCollector;
  readonly signal: AbortSignal;
}): Promise<RunFailure | undefined> {
  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_zero_workflow_automation_check_active_run",
    "nested",
    async (): Promise<RunFailure | undefined> => {
      if (args.activePreviousRunPolicy !== "allow" && args.trigger.lastRunId) {
        const [lastRun] = await args.db
          .select({ status: agentRuns.status })
          .from(agentRuns)
          .where(eq(agentRuns.id, args.trigger.lastRunId))
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

async function checkWorkflowTriggerTargetReadable(args: {
  readonly db: Db;
  readonly trigger: TriggerRow;
  readonly agentId: string;
  readonly allowClaimedOnceScheduleTrigger: boolean;
  readonly timing: ApiDispatchTimingCollector;
  readonly signal: AbortSignal;
}): Promise<RunFailure | undefined> {
  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_zero_workflow_automation_check_target_access",
    "nested",
    async (): Promise<RunFailure | undefined> => {
      const canFire = await workflowTriggerCanFire(args.db, {
        trigger: args.trigger,
        agentId: args.agentId,
        allowClaimedOnceScheduleTrigger: args.allowClaimedOnceScheduleTrigger,
        signal: args.signal,
      });
      args.signal.throwIfAborted();
      if (!canFire) {
        return {
          kind: "conflict",
          message: "Workflow trigger is paused or no longer readable",
        };
      }
      return undefined;
    },
  );
}

async function resolveTimedWorkflowModelContext(args: {
  readonly db: Db;
  readonly trigger: TriggerRow;
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
        orgId: args.trigger.orgId,
        userId: args.trigger.ownerUserId,
        chatThreadId: args.chatThreadId,
        signal: args.signal,
      });
    },
  );
}

async function buildTimedWorkflowTriggerRunInput(args: {
  readonly command: RunWorkflowTriggerNowArgs;
  readonly trigger: TriggerRow;
  readonly agentId: string;
  readonly workflowName: string;
  readonly chatThreadId: string;
  readonly timing: ApiDispatchTimingCollector;
}): Promise<WorkflowTriggerRunInput> {
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
          buildWorkflowTriggerCallbacks(
            args.trigger,
            args.agentId,
            args.chatThreadId,
          ),
        zeroRunMetadata: workflowTriggerRunMetadata(
          args.trigger,
          args.command.triggerBrief,
        ),
        ...(args.trigger.kind === "schedule" &&
        (args.trigger.scheduleType === "cron" ||
          args.trigger.scheduleType === "loop")
          ? { memoryEmbeddingWorkflowTriggerId: args.trigger.id }
          : {}),
      };
    },
  );
}

/**
 * Workflow-queue admission: with the switch on, an event fired while the
 * workflow is busy (or its queue is paused/non-empty) is persisted as a queue
 * event instead of creating a run. Returns true when the event was enqueued.
 */
type ComputedGetter = <T>(computedValue: Computed<T>) => T;

async function enqueueWorkflowTriggerEventIfBusy(input: {
  readonly get: ComputedGetter;
  readonly db: Db;
  readonly args: RunWorkflowTriggerNowArgs;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  const { get, db, args, signal } = input;
  const { trigger, chatThreadId } = args.due;
  if (args.bypassWorkflowQueue === true) {
    return false;
  }
  const overrides = await get(
    userFeatureSwitchOverrides(trigger.orgId, trigger.ownerUserId),
  );
  signal.throwIfAborted();
  if (
    !workflowQueueEnabledForOwner({
      orgId: trigger.orgId,
      userId: trigger.ownerUserId,
      overrides,
    })
  ) {
    return false;
  }
  const admission = await admitWorkflowTriggerEvent(db, {
    trigger,
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
  if (admission === "enqueued") {
    await publishChatThreadWorkflowQueueChangedSafely(
      trigger.ownerUserId,
      chatThreadId,
    );
    signal.throwIfAborted();
    return true;
  }
  return false;
}

async function recordWorkflowTriggerRunStart(input: {
  readonly db: Db;
  readonly args: RunWorkflowTriggerNowArgs;
  readonly runId: string;
  readonly runStatus: string;
  readonly prompt: string;
  readonly modelPin: ModelFirstPin;
  readonly effectiveModelProvider: string | null | undefined;
  readonly signal: AbortSignal;
}): Promise<void> {
  const { db, args, runId, signal } = input;
  const { trigger, chatThreadId } = args.due;
  await postRunUserMessage({
    db,
    threadId: chatThreadId,
    userId: trigger.ownerUserId,
    runId,
    prompt: input.prompt,
    appendQueueMarker: input.runStatus === "queued",
    runGroupId: trigger.id,
  });
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
    .update(zeroWorkflowTriggers)
    .set({
      ...(args.recordLastRunId === false ? {} : { lastRunId: runId }),
      ...(args.recordLastRunAt ? { lastRunAt: nowDate() } : {}),
      updatedAt: nowDate(),
    })
    .where(eq(zeroWorkflowTriggers.id, trigger.id));
  signal.throwIfAborted();
}

export const runWorkflowTriggerNow$ = command(
  async (
    { get, set },
    args: RunWorkflowTriggerNowArgs,
    signal: AbortSignal,
  ): Promise<RunWorkflowTriggerResult> => {
    const db = set(writeDb$);
    const { trigger, agentId, workflowName, chatThreadId } = args.due;
    const timing = workflowTriggerTiming(args);

    const enqueued = await enqueueWorkflowTriggerEventIfBusy({
      get,
      db,
      args,
      signal,
    });
    if (enqueued) {
      return { kind: "enqueued" };
    }

    const activePreviousRunFailure = await checkActivePreviousWorkflowRun({
      db,
      trigger,
      activePreviousRunPolicy: args.activePreviousRunPolicy,
      timing,
      signal,
    });
    if (activePreviousRunFailure) {
      return activePreviousRunFailure;
    }

    const targetAccessFailure = await checkWorkflowTriggerTargetReadable({
      db,
      trigger,
      agentId,
      allowClaimedOnceScheduleTrigger:
        args.due.allowClaimedOnceScheduleTrigger === true,
      timing,
      signal,
    });
    if (targetAccessFailure) {
      return targetAccessFailure;
    }

    const modelContext = await resolveTimedWorkflowModelContext({
      db,
      trigger,
      chatThreadId,
      timing,
      signal,
    });
    if (!modelContext.ok) {
      return modelContext.failure;
    }
    const { modelPin, effectiveModelProvider } = modelContext;

    const runInput = await buildTimedWorkflowTriggerRunInput({
      command: args,
      trigger,
      agentId,
      workflowName,
      chatThreadId,
      timing,
    });
    signal.throwIfAborted();
    timing.recordElapsed(
      "api_dispatch_pre_create_zero_workflow_automation_create_run",
      "nested",
      now(),
    );
    const result = await set(
      createZeroRun$,
      {
        auth: {
          orgId: trigger.orgId,
          orgRole: "member",
          userId: trigger.ownerUserId,
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
        callbacks: runInput.callbacks,
        zeroRunMetadata: runInput.zeroRunMetadata,
        memoryEmbeddingWorkflowTriggerId:
          runInput.memoryEmbeddingWorkflowTriggerId,
        dispatchFailedCallbacks: args.dispatchFailedCallbacks,
        timing,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status !== 201) {
      return { kind: "run_error", response: result };
    }

    await recordWorkflowTriggerRunStart({
      db,
      args,
      runId: result.body.runId,
      runStatus: result.body.status,
      prompt: runInput.prompt,
      modelPin,
      effectiveModelProvider,
      signal,
    });

    return { kind: "ok", runId: result.body.runId };
  },
);
