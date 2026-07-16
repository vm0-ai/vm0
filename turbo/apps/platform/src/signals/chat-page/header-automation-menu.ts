import { command, computed, state, type Computed } from "ccstate";

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

const headerAutomationMenuReload$ = state(0);

/** Bump to force the header automation menu to refetch (e.g. when it opens). */
export const reloadHeaderAutomationMenu$ = command(({ get, set }) => {
  set(headerAutomationMenuReload$, get(headerAutomationMenuReload$) + 1);
});

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
 * Workflow automations bound to a chat thread, for the header automation sidebar.
 */
function createHeaderWorkflowAutomationsFactory(): (
  threadId: string,
) => Computed<Promise<readonly HeaderWorkflowAutomationEntry[]>> {
  const cache = new Map<
    string,
    Computed<Promise<readonly HeaderWorkflowAutomationEntry[]>>
  >();
  return (threadId: string) => {
    const cached = cache.get(threadId);
    if (cached) {
      return cached;
    }
    const automations$ = computed(
      async (get): Promise<readonly HeaderWorkflowAutomationEntry[]> => {
        get(headerAutomationMenuReload$);
        const automations = await listThreadWorkflowAutomations(
          get(zeroClient$),
          {
            threadId,
          },
        );
        const prefs = await get(userPreferences$);
        const displayTz =
          prefs?.timezone ??
          new Intl.DateTimeFormat().resolvedOptions().timeZone;
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
    cache.set(threadId, automations$);
    return automations$;
  };
}

export const headerWorkflowAutomationsForThread =
  createHeaderWorkflowAutomationsFactory();

export const updateHeaderWorkflowScheduleAutomation$ = command(
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
    set(reloadHeaderAutomationMenu$);
  },
);

export const updateHeaderWorkflowGmailNewMessageAutomation$ = command(
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
    set(reloadHeaderAutomationMenu$);
  },
);

export const runHeaderWorkflowAutomationNow$ = command(
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
    set(reloadHeaderAutomationMenu$);
  },
);

export const updateHeaderWorkflowGmailLabelAppliedAutomation$ = command(
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
    set(reloadHeaderAutomationMenu$);
  },
);
