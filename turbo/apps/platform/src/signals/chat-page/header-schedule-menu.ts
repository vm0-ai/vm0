import { command, computed, state } from "ccstate";
import { zeroSchedulesMainContract } from "@vm0/api-contracts/contracts/zero-schedules";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";

interface HeaderScheduleEntry {
  readonly id: string;
  readonly name: string;
}

const headerScheduleMenuReload$ = state(0);

/** Bump to force the header schedule menu to refetch (e.g. when it opens). */
export const reloadHeaderScheduleMenu$ = command(({ get, set }) => {
  set(headerScheduleMenuReload$, get(headerScheduleMenuReload$) + 1);
});

/**
 * All of the user's schedules, for the chat-thread header schedule menu. Read
 * via useLastLoadable; refetched on every menu open via reloadHeaderScheduleMenu$.
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
      return { id: schedule.id, name: schedule.name };
    });
  },
);
