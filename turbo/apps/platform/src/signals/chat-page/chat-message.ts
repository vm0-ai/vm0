import { command, computed, state } from "ccstate";
import { onRef } from "../utils.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import { navigateToChat$ } from "../zero-page/zero-nav.ts";
import {
  currentChatThreadId$,
  chatThreads$,
  reloadChatThreads$,
} from "../agent-chat.ts";
import {
  chatThreadByIdContract,
  type PagedChatMessage,
} from "@vm0/core/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";

export { chatThreads$, reloadChatThreads$ } from "../agent-chat.ts";

export {
  zeroChatAttachments$,
  uploadZeroAttachment$,
  restoreZeroAttachments$,
  removeZeroAttachment$,
  zeroDragOver$,
  setZeroDragOver$,
  canSendZeroChat$,
  type ZeroChatAttachment,
} from "../zero-page/chat-draft.ts";

// ---------------------------------------------------------------------------
// Re-export paged message types from @vm0/core
// ---------------------------------------------------------------------------

export type { PagedChatMessage } from "@vm0/core/contracts/chat-threads";

/** A group of consecutive messages with the same role. */
export interface GroupedChatMessageGroup {
  beginMessageId: string;
  role: "user" | "assistant";
  messages: PagedChatMessage[];
}

// ---------------------------------------------------------------------------
// Delete thread
// ---------------------------------------------------------------------------

export const deleteChatThread$ = command(
  async ({ get, set }, threadId: string, signal: AbortSignal) => {
    const threads = await get(chatThreads$);
    signal.throwIfAborted();

    const client = get(zeroClient$)(chatThreadByIdContract);
    await accept(client.delete({ params: { id: threadId } }), [204]);
    signal.throwIfAborted();

    toast.success("Chat deleted");

    if (get(currentChatThreadId$) === threadId) {
      const idx = threads.findIndex((t) => {
        return t.id === threadId;
      });
      const remaining = threads.filter((t) => {
        return t.id !== threadId;
      });
      if (remaining.length === 0) {
        set(detachedNavigateTo$, "/");
      } else {
        const nextThread = remaining[idx] ?? remaining[remaining.length - 1];
        set(navigateToChat$, nextThread.id);
      }
    }

    set(reloadChatThreads$);
  },
);

// ---------------------------------------------------------------------------
// Composer local UI state
// ---------------------------------------------------------------------------

const internalComposerFileInput$ = state<HTMLElement | null>(null);

export const composerFileInput$ = computed((get) => {
  return get(internalComposerFileInput$);
});

export const setComposerFileInput$ = onRef(
  command(({ set }, el: HTMLElement, signal: AbortSignal) => {
    signal.addEventListener("abort", () => {
      set(internalComposerFileInput$, null);
    });
    set(internalComposerFileInput$, el);
  }),
);
