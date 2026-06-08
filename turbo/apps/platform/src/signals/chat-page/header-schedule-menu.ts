import { command, computed, state } from "ccstate";

import { zeroClient$ } from "../api-client.ts";
import { scheduleTitle } from "../zero-page/schedule-title.ts";
import {
  automationsModeEnabled$,
  listSchedulesVia,
} from "../zero-page/automations-mode.ts";

export interface HeaderScheduleEntry {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly chatThreadId: string;
  readonly enabled: boolean;
  readonly nextRunAt: string | null;
}

const headerScheduleMenuReload$ = state(0);

/** Bump to force the header schedule menu to refetch (e.g. when it opens). */
export const reloadHeaderScheduleMenu$ = command(({ get, set }) => {
  set(headerScheduleMenuReload$, get(headerScheduleMenuReload$) + 1);
});

/**
 * All of the user's schedules, for the chat-thread header schedule menu. Read
 * via useLastLoadable; refetched on every menu open via reloadHeaderScheduleMenu$
 * and on realtime chatThreadSchedulesChanged signals. Consumers filter this to
 * the schedules linked to the current chat thread (see schedulesForThread).
 */
export const headerScheduleMenu$ = computed(
  async (get): Promise<readonly HeaderScheduleEntry[]> => {
    get(headerScheduleMenuReload$);
    const schedules = await listSchedulesVia(
      get(zeroClient$),
      get(automationsModeEnabled$),
      { cache: "no-store" },
    );
    return schedules.map((schedule) => {
      return {
        id: schedule.id,
        name: schedule.name,
        title: scheduleTitle(schedule),
        chatThreadId: schedule.chatThreadId,
        enabled: schedule.enabled,
        nextRunAt: schedule.nextRunAt,
      };
    });
  },
);

/** Schedules linked to a specific chat thread, for the header schedule menu. */
export function schedulesForThread(
  schedules: readonly HeaderScheduleEntry[],
  threadId: string,
): readonly HeaderScheduleEntry[] {
  return schedules.filter((schedule) => {
    return schedule.chatThreadId === threadId;
  });
}
