import { command, computed, state, type Computed } from "ccstate";

import {
  zeroWorkflowTriggersContract,
  type ChatThreadWorkflowTrigger,
  type GmailLabelAppliedEventConfig,
  type GmailNewMessageEventConfig,
  type ZeroWorkflowSchedule,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { userPreferences$ } from "../zero-page/settings/user-preferences.ts";
import {
  listAutomations,
  listThreadWorkflowTriggers,
} from "../zero-page/automations-api.ts";
import { automationToTimeString } from "../zero-page/zero-automations.ts";

export interface HeaderAutomationEntry {
  readonly id: string;
  readonly agentId: string;
  readonly name: string;
  readonly description: string | null;
  readonly chatThreadId: string;
  readonly enabled: boolean;
  readonly nextRunAt: string | null;
  readonly rule: string;
  readonly timezone: string;
}

const headerAutomationMenuReload$ = state(0);

/** Bump to force the header automation menu to refetch (e.g. when it opens). */
export const reloadHeaderAutomationMenu$ = command(({ get, set }) => {
  set(headerAutomationMenuReload$, get(headerAutomationMenuReload$) + 1);
});

/**
 * All of the user's automations, for the chat-thread header automation menu. Read
 * via useLastLoadable; refetched on every menu open via reloadHeaderAutomationMenu$
 * and on realtime chatThreadAutomationsChanged signals. Consumers filter this to
 * the automations linked to the current chat thread (see automationsForThread).
 */
export const headerAutomationMenu$ = computed(
  async (get): Promise<readonly HeaderAutomationEntry[]> => {
    get(headerAutomationMenuReload$);
    const prefs = await get(userPreferences$);
    const displayTz =
      prefs?.timezone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
    const automations = await listAutomations(get(zeroClient$));
    return automations.map((automation) => {
      return {
        id: automation.id,
        agentId: automation.agentId,
        name: automation.name,
        description: automation.description,
        chatThreadId: automation.chatThreadId,
        enabled: automation.enabled,
        nextRunAt: automation.nextRunAt,
        rule: automationToTimeString(automation, displayTz),
        timezone: displayTz,
      };
    });
  },
);

/** Automations linked to a specific chat thread, for the header automation menu. */
export function automationsForThread(
  automations: readonly HeaderAutomationEntry[],
  threadId: string,
): readonly HeaderAutomationEntry[] {
  return automations.filter((automation) => {
    return automation.chatThreadId === threadId;
  });
}

/** A workflow trigger bound to a chat thread, projected for the header automation sidebar. */
export interface HeaderWorkflowTriggerEntry {
  readonly id: string;
  readonly chatThreadId: string;
  readonly enabled: boolean;
  readonly workflowId: string;
  readonly workflowAgentId: string;
  readonly workflowName: string;
  readonly workflowDisplayName: string | null;
  readonly summary: string;
  readonly timezone: string;
  readonly trigger: ChatThreadWorkflowTrigger;
}

function workflowTriggerSummary(trigger: ChatThreadWorkflowTrigger): string {
  if (trigger.kind === "event") {
    if (trigger.eventType === "gmail-new-message") {
      return "Gmail new message";
    }
    if (trigger.eventType === "gmail-label-applied") {
      return "Gmail label applied";
    }
    if (trigger.eventType === "github-label-applied") {
      return "GitHub label applied";
    }
    return "Event";
  }
  return trigger.scheduleSummary ?? "Schedule";
}

/**
 * Workflow triggers bound to a chat thread, for the header automation sidebar.
 */
function createHeaderWorkflowTriggersFactory(): (
  threadId: string,
) => Computed<Promise<readonly HeaderWorkflowTriggerEntry[]>> {
  const cache = new Map<
    string,
    Computed<Promise<readonly HeaderWorkflowTriggerEntry[]>>
  >();
  return (threadId: string) => {
    const cached = cache.get(threadId);
    if (cached) {
      return cached;
    }
    const triggers$ = computed(
      async (get): Promise<readonly HeaderWorkflowTriggerEntry[]> => {
        get(headerAutomationMenuReload$);
        const triggers = await listThreadWorkflowTriggers(get(zeroClient$), {
          threadId,
        });
        const prefs = await get(userPreferences$);
        const displayTz =
          prefs?.timezone ??
          new Intl.DateTimeFormat().resolvedOptions().timeZone;
        return triggers.map((trigger) => {
          return {
            id: trigger.id,
            chatThreadId: trigger.chatThreadId,
            enabled: trigger.enabled,
            workflowId: trigger.workflow.id,
            workflowAgentId: trigger.workflow.agentId,
            workflowName: trigger.workflow.name,
            workflowDisplayName: trigger.workflow.displayName,
            summary: workflowTriggerSummary(trigger),
            timezone: displayTz,
            trigger,
          };
        });
      },
    );
    cache.set(threadId, triggers$);
    return triggers$;
  };
}

export const headerWorkflowTriggersForThread =
  createHeaderWorkflowTriggersFactory();

export const updateHeaderWorkflowScheduleTrigger$ = command(
  async (
    { get, set },
    params: {
      readonly triggerId: string;
      readonly schedule: ZeroWorkflowSchedule;
    },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowTriggersContract);
    await accept(
      client.update({
        params: { id: params.triggerId },
        body: { schedule: params.schedule },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadHeaderAutomationMenu$);
  },
);

export const updateHeaderWorkflowGmailNewMessageTrigger$ = command(
  async (
    { get, set },
    params: {
      readonly triggerId: string;
      readonly eventConfig: GmailNewMessageEventConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowTriggersContract);
    await accept(
      client.update({
        params: { id: params.triggerId },
        body: { eventConfig: params.eventConfig },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadHeaderAutomationMenu$);
  },
);

export const runHeaderWorkflowTriggerNow$ = command(
  async ({ get, set }, triggerId: string, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroWorkflowTriggersContract);
    await accept(
      client.run({
        params: { id: triggerId },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    set(reloadHeaderAutomationMenu$);
  },
);

export const updateHeaderWorkflowGmailLabelAppliedTrigger$ = command(
  async (
    { get, set },
    params: {
      readonly triggerId: string;
      readonly eventConfig: GmailLabelAppliedEventConfig;
    },
    signal: AbortSignal,
  ) => {
    const client = get(zeroClient$)(zeroWorkflowTriggersContract);
    await accept(
      client.update({
        params: { id: params.triggerId },
        body: { eventConfig: params.eventConfig },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadHeaderAutomationMenu$);
  },
);
