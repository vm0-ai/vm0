import { command, computed, state } from "ccstate";
import { zeroSchedulesMainContract } from "@vm0/api-contracts/contracts/zero-schedules";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { scheduleTitle } from "../zero-page/schedule-title.ts";
import { pendingDeleteThreadId$ } from "../zero-page/zero-sidebar-state.ts";

interface HeaderScheduleEntry {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly chatThreadId: string | null;
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
    const client = get(zeroClient$)(zeroSchedulesMainContract);
    const result = await accept(
      client.list({ fetchOptions: { cache: "no-store" } }),
      [200],
      { toast: false },
    );
    return result.body.schedules.map((schedule) => {
      return {
        id: schedule.id,
        name: schedule.name,
        title: scheduleTitle(schedule),
        chatThreadId: schedule.chatThreadId,
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

/**
 * Schedules linked to the chat thread that is pending deletion, for the delete
 * confirmation dialog. Resolves to an empty list without fetching while no
 * delete is pending, so the sidebar only loads the schedule list once the
 * dialog opens.
 */
export const pendingDeleteThreadSchedules$ = computed(
  async (get): Promise<readonly HeaderScheduleEntry[]> => {
    const threadId = get(pendingDeleteThreadId$);
    if (!threadId) {
      return [];
    }
    const schedules = await get(headerScheduleMenu$);
    return schedulesForThread(schedules, threadId);
  },
);
