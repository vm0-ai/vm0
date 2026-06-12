import { agentComposes } from "@vm0/db/schema/agent-compose";
import { automations, automationTriggers } from "@vm0/db/schema/automation";
import type { ChatMessageScheduleSnapshot } from "@vm0/db/schema/chat-message";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq } from "drizzle-orm";

import type { Db } from "../external/db";
import { calculateNextRun } from "./automations/time-trigger";
import {
  resolveModelFirstProviderAdmission,
  type ModelFirstPin,
} from "./zero-model-selection.service";
import { visibleJoinedZeroAgentCondition } from "./zero-agent-data.service";
import {
  postAutomationUserMessage,
  resolveScheduleChatThreadModelPin,
} from "../routes/zero-chat-messages";

// The schedule chip on the run's chat bubble: the snapshot keeps the label
// rendering after the automation is renamed, edited, or deleted.
function chatMessageScheduleSnapshot(
  automation: typeof automations.$inferSelect,
): ChatMessageScheduleSnapshot {
  return {
    id: automation.id,
    title: automation.name,
    description: automation.description ?? null,
  };
}

// Re-exported from the time trigger so existing callers (the reschedule
// callback route and the schedule tests) keep importing it from the service.
export { calculateNextRun };

export type RunCreationErrorResponse = {
  readonly status: 400 | 402 | 403 | 404 | 429 | 503;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
};

interface AgentScheduleTarget {
  readonly id: string;
  readonly name: string;
  readonly displayName: string | null;
}

/**
 * Load an agent the user may target, scoped to the org and the user's
 * visibility: the agent gate shared by the schedule deploy and the v2
 * automation create.
 */
export async function loadAgentForDeploy(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
  },
): Promise<AgentScheduleTarget | null> {
  const [agent] = await db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      displayName: zeroAgents.displayName,
    })
    .from(agentComposes)
    .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
    .where(
      and(
        eq(agentComposes.orgId, args.orgId),
        eq(agentComposes.id, args.agentId),
        visibleJoinedZeroAgentCondition(args.userId),
      ),
    )
    .limit(1);

  return agent ?? null;
}

type ScheduleRunModelContext =
  | {
      readonly ok: true;
      readonly modelPin: ModelFirstPin;
      readonly effectiveModelProvider: string | null | undefined;
    }
  | {
      readonly ok: false;
      readonly failure: {
        readonly kind: "run_error";
        readonly response: RunCreationErrorResponse;
      };
    };

// Resolve the model context for a manually-fired automation run: the thread
// model pin (org default if unpinned) and the admitted provider. No user is
// present to receive a model-config / credits error, so failures surface as
// run_error (normalized to 400) feeding the run-now response. Shared by the
// schedule run-now and the v2 automation run-now.
export async function resolveScheduleRunModelContext(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string;
  readonly signal: AbortSignal;
}): Promise<ScheduleRunModelContext> {
  const threadModelPin = await resolveScheduleChatThreadModelPin({
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

// After a manual run is created: render it as a web-chat turn (with the
// schedule chip), persist the resolved model fields, and stamp the run as
// lastRunId on every trigger of the automation so the per-trigger
// skip-if-active checks (the poller and the run-now conflict) see the active
// manual run. Shared by the schedule run-now (whose automation carries a
// single time trigger, so the stamp is identical to the historic per-trigger
// one) and the v2 automation run-now (where a manual fire belongs to no
// trigger in particular).
export async function persistManualRunSideEffects(args: {
  readonly db: Db;
  readonly automation: typeof automations.$inferSelect;
  readonly runId: string;
  readonly queued: boolean;
  readonly prompt: string;
  readonly modelPin: ModelFirstPin;
  readonly effectiveModelProvider: string | null | undefined;
}): Promise<void> {
  const { automation } = args;
  await postAutomationUserMessage({
    db: args.db,
    threadId: automation.chatThreadId,
    userId: automation.userId,
    runId: args.runId,
    prompt: args.prompt,
    appendQueueMarker: args.queued,
    scheduleTitle: automation.name,
    scheduleSnapshot: chatMessageScheduleSnapshot(automation),
  });

  await args.db
    .update(zeroRuns)
    .set({
      modelProvider: args.effectiveModelProvider,
      modelProviderId: args.modelPin.modelProviderId,
      modelProviderCredentialScope: args.modelPin.modelProviderCredentialScope,
      selectedModel: args.modelPin.selectedModel,
    })
    .where(eq(zeroRuns.id, args.runId));

  await args.db
    .update(automationTriggers)
    .set({ lastRunId: args.runId })
    .where(eq(automationTriggers.automationId, automation.id));
}
