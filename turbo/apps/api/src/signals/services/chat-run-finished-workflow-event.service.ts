import { command } from "ccstate";
import {
  chatRunFinishedEventConfigSchema,
  type ChatRunFinishedEventConfig,
  type ChatRunFinishedRunStatus,
} from "@vm0/api-contracts/contracts/zero-workflows";
import {
  workflowUserAutomationThreads,
  zeroWorkflowAutomations,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { and, eq, sql } from "drizzle-orm";

import { writeDb$ } from "../external/db";
import { now, nowDate } from "../../lib/time";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import {
  buildChatOnlyWorkflowAutomationCallbacks,
  runWorkflowAutomationNow$,
} from "./zero-workflow-automation-run.service";
import {
  workflowAutomationAppendSystemPrompt,
  workflowAutomationPrompt,
  type WorkflowAutomationContext,
} from "./workflow-automation-context.service";
import { ensureWorkflowUserAutomationThread } from "./zero-workflow-user-automation-thread.service";

const CHAT_RUN_FINISHED_EVENT_TYPE = "chat-run-finished";
// Bounds the finished run's output copied into the triggered run's context.
const OUTPUT_EXCERPT_CHAR_CAP = 4000;

export interface ChatRunFinishedEvent {
  readonly chatThreadId: string;
  readonly runId: string;
  readonly runStatus: ChatRunFinishedRunStatus;
  readonly lastResultText: string | null;
}

/**
 * Anchored case-insensitive `*`-wildcard match. Every character except `*`
 * matches literally; a greedy left-to-right segment scan avoids building a
 * regular expression from user input.
 */
function chatRunFinishedPatternMatches(pattern: string, text: string): boolean {
  const segments = pattern.toLowerCase().split("*");
  const haystack = text.toLowerCase();
  if (segments.length === 1) {
    return haystack === segments[0];
  }
  const first = segments[0]!;
  const last = segments[segments.length - 1]!;
  if (!haystack.startsWith(first)) {
    return false;
  }
  let cursor = first.length;
  for (const segment of segments.slice(1, -1)) {
    if (segment.length === 0) {
      continue;
    }
    const index = haystack.indexOf(segment, cursor);
    if (index === -1) {
      return false;
    }
    cursor = index + segment.length;
  }
  return haystack.length - last.length >= cursor && haystack.endsWith(last);
}

function automationMatchesEvent(
  config: ChatRunFinishedEventConfig,
  event: ChatRunFinishedEvent,
): boolean {
  const statuses = config.runStatuses ?? ["completed", "failed", "cancelled"];
  if (!statuses.includes(event.runStatus)) {
    return false;
  }
  if (config.outputPattern === undefined) {
    return true;
  }
  // Failed and cancelled runs often carry no assistant text; error messages
  // are intentionally not searched because users never see them verbatim.
  if (event.lastResultText === null) {
    return false;
  }
  return chatRunFinishedPatternMatches(
    config.outputPattern,
    event.lastResultText,
  );
}

function chatRunFinishedTriggerContext(args: {
  readonly workflowName: string;
  readonly automationId: string;
  readonly event: ChatRunFinishedEvent;
}): WorkflowAutomationContext {
  const excerpt = args.event.lastResultText?.slice(0, OUTPUT_EXCERPT_CHAR_CAP);
  return {
    workflowName: args.workflowName,
    eventType: "chat-run-finished",
    trigger: `run ${args.event.runId} in watched chat thread ${args.event.chatThreadId} finished with status "${args.event.runStatus}".`,
    notes: [
      "Not included below: the finished run's full transcript, and its final output beyond the excerpt. `zero logs <runId>` returns the transcript.",
    ],
    event: {
      automationId: args.automationId,
      eventType: CHAT_RUN_FINISHED_EVENT_TYPE,
      watchedChatThreadId: args.event.chatThreadId,
      runId: args.event.runId,
      runStatus: args.event.runStatus,
      lastResultText: excerpt ?? null,
      lastResultTextTruncated:
        (args.event.lastResultText?.length ?? 0) > OUTPUT_EXCERPT_CHAR_CAP,
    },
  };
}

/**
 * Fires `chat-run-finished` automations watching the thread whose run just
 * reached a terminal state. Called from the terminal chat callback after the
 * run lifecycle marker is durable, so the matched output is final.
 */
export const dispatchChatRunFinishedWorkflowEvents$ = command(
  async ({ set }, event: ChatRunFinishedEvent, signal: AbortSignal) => {
    const db = set(writeDb$);
    const automationRows = await db
      .select({
        automation: zeroWorkflowAutomations,
        agentId: zeroWorkflows.agentId,
        workflowName: zeroWorkflows.name,
        workflowDisplayName: zeroWorkflows.displayName,
        chatThreadId: workflowUserAutomationThreads.chatThreadId,
      })
      .from(zeroWorkflowAutomations)
      .innerJoin(
        zeroWorkflows,
        eq(zeroWorkflowAutomations.workflowId, zeroWorkflows.id),
      )
      .leftJoin(
        workflowUserAutomationThreads,
        and(
          eq(
            workflowUserAutomationThreads.orgId,
            zeroWorkflowAutomations.orgId,
          ),
          eq(
            workflowUserAutomationThreads.userId,
            zeroWorkflowAutomations.ownerUserId,
          ),
          eq(
            workflowUserAutomationThreads.workflowId,
            zeroWorkflowAutomations.workflowId,
          ),
        ),
      )
      .where(
        and(
          eq(zeroWorkflowAutomations.enabled, true),
          eq(zeroWorkflowAutomations.kind, "event"),
          eq(zeroWorkflowAutomations.eventType, CHAT_RUN_FINISHED_EVENT_TYPE),
          eq(
            sql`${zeroWorkflowAutomations.eventConfig}->>'chatThreadId'`,
            event.chatThreadId,
          ),
        ),
      );
    signal.throwIfAborted();

    const currentTime = nowDate();
    for (const row of automationRows) {
      const config = chatRunFinishedEventConfigSchema.safeParse(
        row.automation.eventConfig,
      );
      if (!config.success || !automationMatchesEvent(config.data, event)) {
        continue;
      }

      const chatThreadId =
        row.chatThreadId ??
        (await db.transaction(async (tx) => {
          return await ensureWorkflowUserAutomationThread(tx, {
            orgId: row.automation.orgId,
            userId: row.automation.ownerUserId,
            workflowId: row.automation.workflowId,
            agentId: row.agentId,
            workflowTitle: row.workflowDisplayName ?? row.workflowName,
            currentTime,
          });
        }));
      signal.throwIfAborted();

      const context = chatRunFinishedTriggerContext({
        workflowName: row.workflowName,
        automationId: row.automation.id,
        event,
      });
      await set(
        runWorkflowAutomationNow$,
        {
          due: {
            automation: row.automation,
            agentId: row.agentId,
            workflowName: row.workflowName,
            chatThreadId,
          },
          automationContext: context,
          apiStartTime: now(),
          triggerSource: "workflow-event",
          prompt: workflowAutomationPrompt(context),
          appendSystemPrompt: workflowAutomationAppendSystemPrompt(context),
          triggerBrief: `Chat run ${event.runStatus} in watched thread`,
          callbacks: buildChatOnlyWorkflowAutomationCallbacks(
            chatThreadId,
            row.agentId,
          ),
          activePreviousRunPolicy: "allow",
          recordLastRunId: false,
          recordLastRunAt: true,
          dispatchFailedCallbacks: dispatchFailedRunCallbacks,
        },
        signal,
      );
      signal.throwIfAborted();
    }
  },
);
