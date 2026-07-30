import { randomBytes } from "node:crypto";

import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroWorkflowAutomations } from "@vm0/db/schema/zero-workflow";
import { command } from "ccstate";
import { eq } from "drizzle-orm";

import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../external/time";
import {
  isQueueFirstRunClaimLost,
  type DispatchFailedRunCallbacks,
} from "./agent-run-create.service";
import type { PersistWorkflowQueueSourceTransition } from "./chat-message-queue.service";
import type { InternalRunCallbackKind } from "./internal-run-callback";
import {
  finalizeClaimedRunUserMessage,
  resolveRunChatThreadModelContext,
} from "./zero-chat-run-message.service";
import type { ModelFirstPin } from "./zero-model-selection.service";
import {
  ApiDispatchTimingCollector,
  measureApiDispatchTiming,
} from "./api-dispatch-timing.service";
import { createQueueFirstZeroRun$ } from "./zero-runs-create.service";
import { workflowAutomationCanFire } from "./zero-workflow-automation-access.service";
import { loadComputerUseHostGrantForAutoSend } from "./zero-chat-computer-use-host.service";
import {
  workflowAutomationAppendSystemPrompt,
  workflowAutomationPrompt,
  type WorkflowAutomationContext,
} from "./workflow-automation-context.service";

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
      readonly cliAgentType: string | null;
      readonly codexServiceTier: "fast" | undefined;
    }
  | { readonly ok: false; readonly failure: RunFailure };

export interface RunWorkflowAutomationNowArgs {
  readonly due: DueWorkflowAutomation;
  readonly apiStartTime: number;
  // Overrides the default `/<workflowName>` slash-command prompt.
  readonly prompt?: string;
  // Display-only source context surfaced through workflowSnapshot.triggerBrief.
  readonly triggerBrief?: string;
  readonly triggerSource?: TriggerSource;
  readonly appendSystemPrompt?: string;
  readonly callbacks?: readonly InternalRunCallbackInput[];
  readonly activePreviousRunPolicy?: ActivePreviousRunPolicy;
  // Automated schedule ticks coalesce while pending. Explicit manual runs set
  // this false so every user action remains a distinct queue item.
  readonly coalescePendingScheduleRun?: boolean;
  readonly recordLastRunId?: boolean;
  readonly recordLastRunAt?: boolean;
  /**
   * Admission-only source transition. This callback is never serialized into
   * the durable workflow queue payload.
   */
  readonly persistSourceTransition?: PersistWorkflowQueueSourceTransition;
  readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
  readonly timing?: ApiDispatchTimingCollector;
}

interface LaunchQueuedWorkflowAutomationArgs extends RunWorkflowAutomationNowArgs {
  readonly queueEventId: string;
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

/**
 * Consecutive ticks of the same schedule are otherwise indistinguishable, so the
 * fire time is this run's unique identifier.
 */
function scheduleTriggerContext(args: {
  readonly automation: AutomationRow;
  readonly workflowName: string;
  readonly firedAt: Date;
}): WorkflowAutomationContext {
  const firedAt = args.firedAt.toISOString();
  const recurrence =
    args.automation.scheduleType === "loop"
      ? `every ${args.automation.intervalSeconds}s`
      : args.automation.cronExpression
        ? `cron "${args.automation.cronExpression}" in ${args.automation.timezone}`
        : `once in ${args.automation.timezone}`;
  return {
    workflowName: args.workflowName,
    trigger: `schedule fired at ${firedAt} (${recurrence}).`,
    event: {
      automationId: args.automation.id,
      trigger: "schedule",
      scheduleType: args.automation.scheduleType,
      cronExpression: args.automation.cronExpression,
      intervalSeconds: args.automation.intervalSeconds,
      atTime: args.automation.atTime,
      timezone: args.automation.timezone,
      firedAt,
    },
  };
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
    cliAgentType: providerAdmission.cliAgentType,
    codexServiceTier: runCodexServiceTier,
  };
}

function workflowThreadSessionRoute(
  modelContext: Extract<ModelContext, { readonly ok: true }>,
) {
  return {
    selectedModel: modelContext.modelPin.selectedModel,
    modelProvider: modelContext.effectiveModelProvider ?? null,
    cliAgentType: modelContext.cliAgentType,
  };
}

function workflowAutomationTiming(
  args: LaunchQueuedWorkflowAutomationArgs,
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
      // Event sources carry their own event and build both strings from one
      // trigger line. Only the schedule tick has no event of its own, so it is
      // built here. Guarding on kind keeps a queue row written by a previous
      // deployment (event row without a prompt) from rendering as a schedule.
      const schedule =
        args.automation.kind === "schedule"
          ? scheduleTriggerContext({
              automation: args.automation,
              workflowName: args.workflowName,
              firedAt: new Date(args.command.apiStartTime),
            })
          : null;
      return {
        prompt:
          args.command.prompt ??
          (schedule
            ? workflowAutomationPrompt({
                workflowName: args.workflowName,
                trigger: schedule.trigger,
              })
            : `/${args.workflowName}`),
        appendSystemPrompt: appendComputerUseSystemPrompt(
          args.command.appendSystemPrompt ??
            (schedule ? workflowAutomationAppendSystemPrompt(schedule) : ""),
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

async function recordWorkflowAutomationRunStart(input: {
  readonly db: Db;
  readonly args: RunWorkflowAutomationNowArgs;
  readonly runId: string;
  readonly runStatus: string;
  readonly claimedMessageCreatedAt: Date;
  readonly signal: AbortSignal;
}): Promise<void> {
  const { db, args, runId, signal } = input;
  const { automation, chatThreadId } = args.due;
  await finalizeClaimedRunUserMessage({
    db,
    threadId: chatThreadId,
    userId: automation.ownerUserId,
    runId,
    runStatus: input.runStatus,
    runGroupId: automation.id,
    createdAt: input.claimedMessageCreatedAt,
  });
  signal.throwIfAborted();

  await db
    .update(zeroWorkflowAutomations)
    .set({
      ...(args.recordLastRunId === false ? {} : { lastRunId: runId }),
      ...(args.recordLastRunAt ? { lastRunAt: nowDate() } : {}),
      ...(args.due.allowClaimedOnceScheduleAutomation
        ? { enabled: false }
        : {}),
      updatedAt: nowDate(),
    })
    .where(eq(zeroWorkflowAutomations.id, automation.id));
  signal.throwIfAborted();
}

export const launchQueuedWorkflowAutomation$ = command(
  async (
    { set },
    args: LaunchQueuedWorkflowAutomationArgs,
    signal: AbortSignal,
  ): Promise<RunWorkflowAutomationResult> => {
    const db = set(writeDb$);
    const { automation, agentId, workflowName, chatThreadId } = args.due;
    const timing = workflowAutomationTiming(args);

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
      createQueueFirstZeroRun$,
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
          ...(effectiveModelProvider
            ? { modelProvider: effectiveModelProvider }
            : {}),
        },
        apiStartTime: args.apiStartTime,
        triggerSource: args.triggerSource ?? "workflow-schedule",
        chatThreadId,
        computerUseHostId: computerUseHostGrant?.hostId,
        modelProviderId: modelPin.modelProviderId ?? undefined,
        modelProviderCredentialScope:
          modelPin.modelProviderCredentialScope ?? undefined,
        selectedModelOverride: modelPin.selectedModel ?? undefined,
        threadSessionRoute: workflowThreadSessionRoute(modelContext),
        codexServiceTier,
        appendSystemPrompt: runInput.appendSystemPrompt,
        callbacks: runInput.callbacks,
        zeroRunMetadata: runInput.zeroRunMetadata,
        queueFirstAssociation: {
          kind: "workflow_event",
          threadId: chatThreadId,
          eventId: args.queueEventId,
          prompt: runInput.prompt,
          runGroupId: automation.id,
        },
        zeroRunModelPin: {
          modelProvider: effectiveModelProvider ?? null,
          modelProviderId: modelPin.modelProviderId,
          modelProviderCredentialScope: modelPin.modelProviderCredentialScope,
          selectedModel: modelPin.selectedModel,
        },
        dispatchFailedCallbacks: args.dispatchFailedCallbacks,
        timing,
      },
      signal,
    );
    signal.throwIfAborted();

    if (isQueueFirstRunClaimLost(result)) {
      return { kind: "enqueued" };
    }
    if (result.status !== 201) {
      return { kind: "run_error", response: result };
    }

    await recordWorkflowAutomationRunStart({
      db,
      args,
      runId: result.body.runId,
      runStatus: result.body.status,
      claimedMessageCreatedAt: result.queueFirstClaim.createdAt,
      signal,
    });

    return { kind: "ok", runId: result.body.runId };
  },
);
