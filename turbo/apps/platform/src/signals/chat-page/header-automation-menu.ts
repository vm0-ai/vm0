import { command, computed, state } from "ccstate";

import { zeroClient$ } from "../api-client.ts";
import { automationTitle } from "../zero-page/automation-title.ts";
import { listAutomations } from "../zero-page/automations-api.ts";

export interface HeaderAutomationEntry {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly chatThreadId: string;
  readonly enabled: boolean;
  readonly nextRunAt: string | null;
}

const headerAutomationMenuReload$ = state(0);

/** Bump to force the header automation menu to refetch (e.g. when it opens). */
export const reloadHeaderAutomationMenu$ = command(({ get, set }) => {
  set(headerAutomationMenuReload$, get(headerAutomationMenuReload$) + 1);
});

/**
 * All of the user's automations, for the chat-thread header automation menu. Read
 * via useLastLoadable; refetched on every menu open via reloadHeaderAutomationMenu$
 * and on realtime chatThreadSchedulesChanged signals. Consumers filter this to
 * the automations linked to the current chat thread (see automationsForThread).
 */
export const headerAutomationMenu$ = computed(
  async (get): Promise<readonly HeaderAutomationEntry[]> => {
    get(headerAutomationMenuReload$);
    const automations = await listAutomations(get(zeroClient$), {
      cache: "no-store",
    });
    return automations.map((automation) => {
      return {
        id: automation.id,
        name: automation.name,
        title: automationTitle(automation),
        chatThreadId: automation.chatThreadId,
        enabled: automation.enabled,
        nextRunAt: automation.nextRunAt,
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
