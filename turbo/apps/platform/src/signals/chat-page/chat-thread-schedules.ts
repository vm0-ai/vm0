import { computed, type Computed } from "ccstate";
import { zeroSchedulesMainContract } from "@vm0/api-contracts/contracts/zero-schedules";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";

interface ChatThreadScheduleEntry {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
}

/**
 * Per-thread list of the schedules linked to a chat thread (chat-mode
 * schedules). Read-only and cached per threadId. The header schedule menu reads
 * this to list a thread's schedules and to hide itself when there are none.
 * Mirrors createChatThreadGithubPrsFactory in github-pr-tracking.ts.
 */
function createChatThreadSchedulesFactory(): (
  threadId: string,
) => Computed<Promise<readonly ChatThreadScheduleEntry[]>> {
  const cache = new Map<
    string,
    Computed<Promise<readonly ChatThreadScheduleEntry[]>>
  >();
  return (threadId: string) => {
    const existing = cache.get(threadId);
    if (existing) {
      return existing;
    }

    const atom$ = computed(
      async (get): Promise<readonly ChatThreadScheduleEntry[]> => {
        const client = get(zeroClient$)(zeroSchedulesMainContract);
        const result = await accept(
          client.list({ fetchOptions: { cache: "no-store" } }),
          [200],
          { toast: false },
        );
        return result.body.schedules
          .filter((schedule) => {
            return schedule.chatThreadId === threadId;
          })
          .map((schedule) => {
            return {
              id: schedule.id,
              name: schedule.name,
              enabled: schedule.enabled,
            };
          });
      },
    );

    cache.set(threadId, atom$);
    return atom$;
  };
}

export const chatThreadSchedules$ = createChatThreadSchedulesFactory();
