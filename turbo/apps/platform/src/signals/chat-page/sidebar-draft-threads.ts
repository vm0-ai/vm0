import { command, computed, state } from "ccstate";
import { chatThreadsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { sidebarChatThreadIds$ } from "./sidebar-chat-thread-ids.ts";

const internalReloadSidebarDrafts$ = state(0);

/**
 * Bump after a local draft save so the sidebar draft dots refresh without a
 * full thread-list reload. Draft changes are not broadcast by the server.
 */
export const reloadSidebarDraftThreads$ = command(({ set }) => {
  set(internalReloadSidebarDrafts$, (n) => {
    return n + 1;
  });
});

/**
 * Ids of the sidebar threads that hold an unsent composer draft. Fetched
 * separately from the thread list so the list query stays cheap; the draft
 * dot may render a beat after the rows themselves.
 */
export const sidebarDraftThreadIds$ = computed(
  async (get): Promise<ReadonlySet<string>> => {
    get(internalReloadSidebarDrafts$);
    const threadIds = await get(sidebarChatThreadIds$);
    if (threadIds.length === 0) {
      return new Set();
    }

    const client = get(zeroClient$)(chatThreadsContract);
    const result = await accept(
      client.drafts({
        query: {
          threadIds: threadIds.join(","),
        },
      }),
      [200],
    );
    return new Set(result.body.draftThreadIds);
  },
);
