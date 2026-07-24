import { command, computed, state, type Command, type Computed } from "ccstate";

import {
  zeroWorkflowAutomationsContract,
  type ChatThreadWorkflowAutomation,
  type GmailLabelAppliedEventConfig,
  type GmailNewMessageEventConfig,
  type ZeroWorkflowSchedule,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { userPreferences$ } from "../zero-page/settings/user-preferences.ts";
import { listThreadWorkflowAutomations } from "../zero-page/workflow-automations-api.ts";

/** A workflow automation bound to a chat thread, projected for the header automation sidebar. */
export interface HeaderWorkflowAutomationEntry {
  readonly id: string;
  readonly chatThreadId: string;
  readonly enabled: boolean;
  readonly workflowId: string;
  readonly workflowAgentId: string;
  readonly workflowName: string;
  readonly workflowDisplayName: string | null;
  readonly summary: string;
  readonly timezone: string;
  readonly automation: ChatThreadWorkflowAutomation;
}

export interface HeaderAutomationSignals {
  readonly automations$: Computed<
    Promise<readonly HeaderWorkflowAutomationEntry[]>
  >;
  readonly reload$: Command<void, []>;
  readonly updateSchedule$: Command<
    Promise<void>,
    [
      {
        readonly automationId: string;
        readonly schedule: ZeroWorkflowSchedule;
      },
      AbortSignal,
    ]
  >;
  readonly updateGmailNewMessage$: Command<
    Promise<void>,
    [
      {
        readonly automationId: string;
        readonly eventConfig: GmailNewMessageEventConfig;
      },
      AbortSignal,
    ]
  >;
  readonly updateGmailLabelApplied$: Command<
    Promise<void>,
    [
      {
        readonly automationId: string;
        readonly eventConfig: GmailLabelAppliedEventConfig;
      },
      AbortSignal,
    ]
  >;
  readonly runNow$: Command<Promise<void>, [string, AbortSignal]>;
}

function workflowAutomationSummary(
  automation: ChatThreadWorkflowAutomation,
): string {
  if (automation.kind === "event") {
    if (automation.eventType === "gmail-new-message") {
      return "Gmail new message";
    }
    if (automation.eventType === "gmail-label-applied") {
      return "Gmail label applied";
    }
    if (automation.eventType === "github-label-applied") {
      return "GitHub label applied";
    }
    if (automation.eventType === "github-workflow-job-completed") {
      return "GitHub workflow job completed";
    }
    if (automation.eventType === "github-pull-request-review-submitted") {
      return "GitHub pull request review submitted";
    }
    if (automation.eventType === "github-deployment-status-created") {
      return "GitHub deployment status created";
    }
    if (automation.eventType === "github-issue-comment-created") {
      return "GitHub issue comment created";
    }
    if (automation.eventType === "github-workflow-run-completed") {
      return "GitHub workflow completed";
    }
    if (automation.eventType === "notion-child-page-created") {
      return "New Notion child page";
    }
    if (automation.eventType === "notion-database-item-created") {
      return "New Notion database item";
    }
    return "Event";
  }
  return automation.scheduleSummary ?? "Schedule";
}

/**
 * Create the automation graph owned by one chat-thread signal instance.
 */
export function createHeaderAutomationSignals(
  threadId: string,
): HeaderAutomationSignals {
  const reloadVersion$ = state(0);

  const reload$ = command(({ set }) => {
    set(reloadVersion$, (version) => {
      return version + 1;
    });
  });

  const automations$ = computed(
    async (get): Promise<readonly HeaderWorkflowAutomationEntry[]> => {
      get(reloadVersion$);
      const automations = await listThreadWorkflowAutomations(
        get(zeroClient$),
        { threadId },
      );
      const prefs = await get(userPreferences$);
      const displayTz =
        prefs?.timezone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
      return automations.map((automation) => {
        return {
          id: automation.id,
          chatThreadId: automation.chatThreadId,
          enabled: automation.enabled,
          workflowId: automation.workflow.id,
          workflowAgentId: automation.workflow.agentId,
          workflowName: automation.workflow.name,
          workflowDisplayName: automation.workflow.displayName,
          summary: workflowAutomationSummary(automation),
          timezone: displayTz,
          automation,
        };
      });
    },
  );

  const updateSchedule$ = command(
    async (
      { get, set },
      params: {
        readonly automationId: string;
        readonly schedule: ZeroWorkflowSchedule;
      },
      signal: AbortSignal,
    ) => {
      const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
      await accept(
        client.update({
          params: { id: params.automationId },
          body: { schedule: params.schedule },
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
      set(reload$);
    },
  );

  const updateGmailNewMessage$ = command(
    async (
      { get, set },
      params: {
        readonly automationId: string;
        readonly eventConfig: GmailNewMessageEventConfig;
      },
      signal: AbortSignal,
    ) => {
      const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
      await accept(
        client.update({
          params: { id: params.automationId },
          body: { eventConfig: params.eventConfig },
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
      set(reload$);
    },
  );

  const updateGmailLabelApplied$ = command(
    async (
      { get, set },
      params: {
        readonly automationId: string;
        readonly eventConfig: GmailLabelAppliedEventConfig;
      },
      signal: AbortSignal,
    ) => {
      const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
      await accept(
        client.update({
          params: { id: params.automationId },
          body: { eventConfig: params.eventConfig },
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
      set(reload$);
    },
  );

  const runNow$ = command(
    async ({ get, set }, automationId: string, signal: AbortSignal) => {
      const client = get(zeroClient$)(zeroWorkflowAutomationsContract);
      await accept(
        client.run({
          params: { id: automationId },
          fetchOptions: { signal },
        }),
        [201],
      );
      signal.throwIfAborted();
      set(reload$);
    },
  );

  return {
    automations$,
    reload$,
    updateSchedule$,
    updateGmailNewMessage$,
    updateGmailLabelApplied$,
    runNow$,
  };
}
