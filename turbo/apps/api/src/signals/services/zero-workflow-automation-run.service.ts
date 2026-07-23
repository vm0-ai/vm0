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
import type { DispatchFailedRunCallbacks } from "./agent-run-create.service";
import type { InternalRunCallbackKind } from "./internal-run-callback";
import {
  postRunUserMessage,
  resolveRunChatThreadModelContext,
} from "./zero-chat-run-message.service";
import type { ModelFirstPin } from "./zero-model-selection.service";
import {
  ApiDispatchTimingCollector,
  measureApiDispatchTiming,
} from "./api-dispatch-timing.service";
import { createZeroRun$ } from "./zero-runs-create.service";
import { admitWorkflowAutomationEvent } from "./chat-message-queue.service";
import { workflowAutomationCanFire } from "./zero-workflow-automation-access.service";
import { loadComputerUseHostGrantForAutoSend } from "./zero-chat-computer-use-host.service";

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
      readonly codexServiceTier: "fast" | undefined;
    }
  | { readonly ok: false; readonly failure: RunFailure };

export interface RunWorkflowAutomationNowArgs {
  readonly due: DueWorkflowAutomation;
  readonly apiStartTime: number;
  readonly firstAssistantTimingStartedAt?: Date | null;
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

interface WorkflowAutomationRunInput {
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly callbacks: readonly InternalRunCallbackInput[];
  readonly zeroRunMetadata: ReturnType<typeof workflowAutomationRunMetadata>;
}

type ComputerUseHostGrant = Awaited<
  ReturnType<typeof loadComputerUseHostGrantForAutoSend>
>;

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

function appendComputerUseSystemPrompt(
  prompt: string,
  grant: ComputerUseHostGrant,
): string {
  if (!grant) {
    return prompt;
  }
  return [
    prompt,
    "# Computer Use",
    `Computer Use is enabled for this run on ${grant.displayName}.`,
  ].join("\n\n");
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
  const threadModelContext = await resolveRunChatThreadModelContext({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    threadId: args.chatThreadId,
  });
  args.signal.throwIfAborted();
  if ("status" in threadModelContext) {
    return {
      ok: false,
      failure: {
        kind: "run_error",
        response: {
          status: threadModelContext.status,
          body: threadModelContext.body,
        },
      },
    };
  }

  const { pin, providerAdmission, runCodexServiceTier } = threadModelContext;
  args.signal.throwIfAborted();
  if (providerAdmission.error) {
    return {
      ok: false,
      failure: { kind: "run_error", response: providerAdmission.error },
    };
  }

  return {
    ok: true,
    modelPin: pin,
    effectiveModelProvider: providerAdmission.effectiveModelProvider,
    codexServiceTier: runCodexServiceTier,
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
}): Promise<RunFailure | undefined> {
  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_zero_workflow_automation_check_target_access",
    "nested",
    async (): Promise<RunFailure | undefined> => {
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
  readonly computerUseHostGrant: ComputerUseHostGrant;
  readonly timing: ApiDispatchTimingCollector;
}): Promise<WorkflowAutomationRunInput> {
  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_zero_workflow_automation_build_run_input",
    "nested",
    () => {
      return {
        prompt: args.command.prompt ?? `/${args.workflowName}`,
        appendSystemPrompt: appendComputerUseSystemPrompt(
          args.command.appendSystemPrompt ??
            buildAppendSystemPrompt(args.workflowName),
          args.computerUseHostGrant,
        ),
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

/**
 * Workflow-queue admission: an event fired while the workflow is busy (or its
 * queue is paused/non-empty) is persisted as a queue event instead of creating
 * a run. Returns true when the event was enqueued.
 */
async function enqueueWorkflowAutomationEventIfBusy(input: {
  readonly db: Db;
  readonly args: RunWorkflowAutomationNowArgs;
  readonly timing: ApiDispatchTimingCollector;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  const { db, args, signal, timing } = input;
  const { automation, chatThreadId } = args.due;
  if (args.bypassWorkflowQueue === true) {
    return false;
  }
  const admission = await measureApiDispatchTiming(
    timing,
    "api_dispatch_pre_create_zero_workflow_automation_queue_admission",
    "nested",
    async () => {
      return await admitWorkflowAutomationEvent(db, {
        automation,
        chatThreadId,
        apiStartedAt: new Date(args.apiStartTime),
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
    },
  );
  signal.throwIfAborted();
  if (admission === "enqueued") {
    await publishChatThreadWorkflowQueueChangedSafely(
      automation.ownerUserId,
      chatThreadId,
    );
    signal.throwIfAborted();
    return true;
  }
  return false;
}

async function recordWorkflowAutomationRunStart(input: {
  readonly db: Db;
  readonly args: RunWorkflowAutomationNowArgs;
  readonly runId: string;
  readonly runStatus: string;
  readonly prompt: string;
  readonly modelPin: ModelFirstPin;
  readonly effectiveModelProvider: string | null | undefined;
  readonly signal: AbortSignal;
}): Promise<void> {
  const { db, args, runId, signal } = input;
  const { automation, chatThreadId } = args.due;
  await postRunUserMessage({
    db,
    threadId: chatThreadId,
    userId: automation.ownerUserId,
    runId,
    prompt: input.prompt,
    appendQueueMarker: input.runStatus === "queued",
    runGroupId: automation.id,
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
    .update(zeroWorkflowAutomations)
    .set({
      ...(args.recordLastRunId === false ? {} : { lastRunId: runId }),
      ...(args.recordLastRunAt ? { lastRunAt: nowDate() } : {}),
      updatedAt: nowDate(),
    })
    .where(eq(zeroWorkflowAutomations.id, automation.id));
  signal.throwIfAborted();
}

export const runWorkflowAutomationNow$ = command(
  async (
    { set },
    args: RunWorkflowAutomationNowArgs,
    signal: AbortSignal,
  ): Promise<RunWorkflowAutomationResult> => {
    const db = set(writeDb$);
    const { automation, agentId, workflowName, chatThreadId } = args.due;
    const timing = workflowAutomationTiming(args);

    const enqueued = await enqueueWorkflowAutomationEventIfBusy({
      db,
      args,
      timing,
      signal,
    });
    if (enqueued) {
      return { kind: "enqueued" };
    }

    const activePreviousRunFailure = await checkActivePreviousWorkflowRun({
      db,
      automation,
      activePreviousRunPolicy: args.activePreviousRunPolicy,
      timing,
      signal,
    });
    if (activePreviousRunFailure) {
      return activePreviousRunFailure;
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
      return targetAccessFailure;
    }

    const modelContext = await resolveTimedWorkflowModelContext({
      db,
      automation,
      chatThreadId,
      timing,
      signal,
    });
    if (!modelContext.ok) {
      return modelContext.failure;
    }
    const { modelPin, effectiveModelProvider, codexServiceTier } = modelContext;

    const computerUseHostGrant = await loadComputerUseHostGrantForAutoSend({
      db,
      threadId: chatThreadId,
      orgId: automation.orgId,
      userId: automation.ownerUserId,
    });
    signal.throwIfAborted();

    const runInput = await buildTimedWorkflowAutomationRunInput({
      command: args,
      automation,
      agentId,
      workflowName,
      chatThreadId,
      computerUseHostGrant,
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
        firstAssistantTimingStartedAt: args.firstAssistantTimingStartedAt,
        triggerSource: args.triggerSource ?? "workflow-schedule",
        chatThreadId,
        computerUseHostId: computerUseHostGrant?.hostId,
        modelProviderId: modelPin.modelProviderId ?? undefined,
        modelProviderCredentialScope:
          modelPin.modelProviderCredentialScope ?? undefined,
        selectedModelOverride: modelPin.selectedModel ?? undefined,
        codexServiceTier,
        appendSystemPrompt: runInput.appendSystemPrompt,
        callbacks: runInput.callbacks,
        zeroRunMetadata: runInput.zeroRunMetadata,
        dispatchFailedCallbacks: args.dispatchFailedCallbacks,
        timing,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status !== 201) {
      return { kind: "run_error", response: result };
    }

    await recordWorkflowAutomationRunStart({
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
