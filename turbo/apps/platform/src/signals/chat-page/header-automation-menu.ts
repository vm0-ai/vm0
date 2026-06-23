import { command, computed, state, type Computed } from "ccstate";

import type { ChatThreadWorkflowTrigger } from "@vm0/api-contracts/contracts/zero-workflows";
import { zeroClient$ } from "../api-client.ts";
import { userPreferences$ } from "../zero-page/settings/user-preferences.ts";
import {
  listAutomations,
  listThreadWorkflowTriggers,
  setWorkflowTriggerEnabled,
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

/**
 * A workflow trigger bound to a chat thread, projected for the header
 * automation sidebar. Goal triggers live in the composer through the goal API.
 */
export interface HeaderWorkflowTriggerEntry {
  readonly id: string;
  readonly chatThreadId: string;
  readonly enabled: boolean;
  readonly workflowName: string;
  readonly workflowDisplayName: string | null;
  readonly workflowDescription: string | null;
  readonly summary: string;
}

function workflowTriggerSummary(trigger: ChatThreadWorkflowTrigger): string {
  if (trigger.kind === "event") {
    if (trigger.eventType === "thread-idle") {
      return "On thread idle";
    }
    return trigger.eventType ?? "Event";
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
        return triggers.map((trigger) => {
          return {
            id: trigger.id,
            chatThreadId: trigger.chatThreadId,
            enabled: trigger.enabled,
            workflowName: trigger.workflow.name,
            workflowDisplayName: trigger.workflow.displayName,
            workflowDescription: trigger.workflow.description,
            summary: workflowTriggerSummary(trigger),
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

/**
 * Enable/disable a thread's workflow trigger from the sidebar toggle,
 * then refetch so the card reflects the new state. The backend also publishes
 * the realtime signal so other open clients refresh.
 */
export const toggleWorkflowTriggerEnabled$ = command(
  async (
    { get, set },
    params: { readonly triggerId: string; readonly enabled: boolean },
    signal: AbortSignal,
  ) => {
    await setWorkflowTriggerEnabled(get(zeroClient$), params);
    signal.throwIfAborted();
    set(reloadHeaderAutomationMenu$);
  },
);
