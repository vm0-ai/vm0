import { randomBytes } from "node:crypto";

import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { zeroWorkflowTriggers } from "@vm0/db/schema/zero-workflow";
import { command } from "ccstate";
import { eq } from "drizzle-orm";

import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import type { DispatchFailedRunCallbacks } from "./agent-run-create.service";
import type { InternalRunCallbackKind } from "./internal-run-callback";
import {
  postAutomationUserMessage,
  resolveAutomationChatThreadModelPin,
} from "./zero-chat-automation-message.service";
import {
  resolveModelFirstProviderAdmission,
  type ModelFirstPin,
} from "./zero-model-selection.service";
import { createZeroRun$ } from "./zero-runs-create.service";

export type TriggerRow = typeof zeroWorkflowTriggers.$inferSelect;

export interface DueWorkflowTrigger {
  readonly trigger: TriggerRow;
  // The owning agent is derived from the workflow row (hard 1:N); triggers no
  // longer carry an agentId column, so callers resolve it and pass it here.
  readonly agentId: string;
  readonly workflowName: string;
}

export type RunErrorResponse = {
  readonly status: number;
  readonly body: {
    readonly error: { readonly message: string; readonly code: string };
  };
};

export type RunWorkflowTriggerResult =
  | { readonly kind: "ok"; readonly runId: string }
  | { readonly kind: "conflict"; readonly message: string }
  | { readonly kind: "run_error"; readonly response: RunErrorResponse };

export type RunFailure = Exclude<RunWorkflowTriggerResult, { kind: "ok" }>;

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

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

function isActivePreviousRunStatus(status: string): boolean {
  return status === "pending" || status === "running";
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
): InternalRunCallbackInput[] {
  const callbacks: InternalRunCallbackInput[] = [];
  if (trigger.scheduleType === "loop") {
    callbacks.push({
      internalKind: "workflow-trigger:loop",
      secret: generateCallbackSecret(),
      payload: { triggerId: trigger.id },
    });
  } else {
    callbacks.push({
      internalKind: "workflow-trigger:cron",
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
  if (trigger.chatThreadId) {
    callbacks.push({
      internalKind: "chat",
      secret: generateCallbackSecret(),
      payload: { threadId: trigger.chatThreadId, agentId },
    });
  }
  return callbacks;
}

function buildAppendSystemPrompt(workflowName: string): string {
  return [
    "# Current context",
    `You are running on a schedule trigger for the "${workflowName}" workflow.`,
    "The workflow's procedure is available as a skill - execute it now.",
    "This run is linked to a web chat thread; everything you output is shown to the user there.",
  ].join("\n");
}

export function buildChatOnlyWorkflowTriggerCallbacks(
  trigger: TriggerRow,
  agentId: string,
  options?: { readonly isGoalRun?: boolean },
): InternalRunCallbackInput[] {
  if (!trigger.chatThreadId) {
    return [];
  }
  return [
    {
      internalKind: "chat",
      secret: generateCallbackSecret(),
      payload: {
        threadId: trigger.chatThreadId,
        agentId,
        // Goal runs self-continue on idle; the flag lets the chat callback
        // gate terminal push notifications to terminal goal states only.
        ...(options?.isGoalRun ? { isGoalRun: true } : {}),
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
  const threadModelPin = await resolveAutomationChatThreadModelPin({
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

export const runWorkflowTriggerNow$ = command(
  async (
    { set },
    args: {
      readonly due: DueWorkflowTrigger;
      readonly apiStartTime: number;
      readonly sessionId?: string;
      // Overrides the default `/<workflowName>` slash-command prompt. Goals pass
      // a rendered continuation template here so the turn is plain instruction
      // text — a bare `/goal` would collide with the harness's built-in `/goal`
      // slash command and no-op.
      readonly prompt?: string;
      readonly triggerSource?: TriggerSource;
      readonly appendSystemPrompt?: string;
      readonly callbacks?: readonly InternalRunCallbackInput[];
      readonly recordLastRunId?: boolean;
      readonly recordLastRunAt?: boolean;
      readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
    },
    signal: AbortSignal,
  ): Promise<RunWorkflowTriggerResult> => {
    const db = set(writeDb$);
    const { trigger, agentId, workflowName } = args.due;

    if (!trigger.chatThreadId) {
      return {
        kind: "run_error",
        response: {
          status: 400,
          body: {
            error: {
              message: "Workflow trigger is missing its thread",
              code: "INVALID_TRIGGER",
            },
          },
        },
      };
    }
    const chatThreadId = trigger.chatThreadId;

    if (trigger.lastRunId) {
      const [lastRun] = await db
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, trigger.lastRunId))
        .limit(1);
      signal.throwIfAborted();
      if (lastRun && isActivePreviousRunStatus(lastRun.status)) {
        return { kind: "conflict", message: "Previous run is still active" };
      }
    }

    const modelContext = await resolveModelContext({
      db,
      orgId: trigger.orgId,
      userId: trigger.ownerUserId,
      chatThreadId,
      signal,
    });
    if (!modelContext.ok) {
      return modelContext.failure;
    }
    const { modelPin, effectiveModelProvider } = modelContext;

    const prompt = args.prompt ?? `/${workflowName}`;
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
          prompt,
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
        appendSystemPrompt:
          args.appendSystemPrompt ?? buildAppendSystemPrompt(workflowName),
        callbacks:
          args.callbacks ?? buildWorkflowTriggerCallbacks(trigger, agentId),
        zeroRunMetadata: {
          workflowTriggerId: trigger.id,
        },
        dispatchFailedCallbacks: args.dispatchFailedCallbacks,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status !== 201) {
      return { kind: "run_error", response: result };
    }

    await postAutomationUserMessage({
      db,
      threadId: chatThreadId,
      userId: trigger.ownerUserId,
      runId: result.body.runId,
      prompt,
      appendQueueMarker: result.body.status === "queued",
    });
    signal.throwIfAborted();

    await db
      .update(zeroRuns)
      .set({
        modelProvider: effectiveModelProvider,
        modelProviderId: modelPin.modelProviderId,
        modelProviderCredentialScope: modelPin.modelProviderCredentialScope,
        selectedModel: modelPin.selectedModel,
      })
      .where(eq(zeroRuns.id, result.body.runId));
    signal.throwIfAborted();

    await db
      .update(zeroWorkflowTriggers)
      .set({
        ...(args.recordLastRunId === false
          ? {}
          : { lastRunId: result.body.runId }),
        ...(args.recordLastRunAt ? { lastRunAt: nowDate() } : {}),
        updatedAt: nowDate(),
      })
      .where(eq(zeroWorkflowTriggers.id, trigger.id));
    signal.throwIfAborted();

    return { kind: "ok", runId: result.body.runId };
  },
);
