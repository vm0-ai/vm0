import { command, computed, state } from "ccstate";

import type { ChatThreadWorkflowTrigger } from "@vm0/api-contracts/contracts/automations";
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
    const automations = await listAutomations(get(zeroClient$), {
      cache: "no-store",
    });
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
 * A workflow or goal trigger bound to a chat thread, projected for the header
 * automation sidebar. Carries the linked workflow's identity + description so a
 * thread's automation panel can show the recurring workflows/goals attached to
 * it next to the automations.
 */
export interface HeaderWorkflowTriggerEntry {
  readonly id: string;
  readonly chatThreadId: string;
  readonly enabled: boolean;
  readonly workflowName: string;
  readonly workflowDisplayName: string | null;
  readonly workflowDescription: string | null;
  readonly workflowType: "workflow" | "goal";
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
 * All workflow + goal triggers bound to the user's chat threads, for the header
 * automation sidebar. Refetched alongside the automation menu; consumers filter
 * to the current thread via workflowTriggersForThread.
 */
export const headerWorkflowTriggers$ = computed(
  async (get): Promise<readonly HeaderWorkflowTriggerEntry[]> => {
    get(headerAutomationMenuReload$);
    const triggers = await listThreadWorkflowTriggers(get(zeroClient$), {
      cache: "no-store",
    });
    return triggers.map((trigger) => {
      return {
        id: trigger.id,
        chatThreadId: trigger.chatThreadId,
        enabled: trigger.enabled,
        workflowName: trigger.workflow.name,
        workflowDisplayName: trigger.workflow.displayName,
        workflowDescription: trigger.workflow.description,
        workflowType: trigger.workflow.type,
        summary: workflowTriggerSummary(trigger),
      };
    });
  },
);

/** Workflow/goal triggers bound to a specific chat thread, for the sidebar. */
export function workflowTriggersForThread(
  triggers: readonly HeaderWorkflowTriggerEntry[],
  threadId: string,
): readonly HeaderWorkflowTriggerEntry[] {
  return triggers.filter((trigger) => {
    return trigger.chatThreadId === threadId;
  });
}
