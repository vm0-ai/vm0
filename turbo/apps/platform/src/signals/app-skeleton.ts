import { command, computed, state } from "ccstate";
import { currentChatAgent$ } from "./agent-chat.ts";
import { resolveAvatarUrl } from "../views/zero-page/avatar-utils.ts";
import { throwIfAbort } from "./utils.ts";

const internalVisible$ = state(true);

export const appSkeletonVisible$ = computed((get) => {
  return get(internalVisible$);
});

export const showAppSkeleton$ = command(({ set }) => {
  set(internalVisible$, true);
});

export const hideAppSkeleton$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    // Avatar prefetch is a best-effort cache warm-up: a missing or
    // unavailable agent should not prevent the skeleton from hiding.
    // eslint-disable-next-line no-restricted-syntax -- TODO(no-try): remove — restructure best-effort prefetch
    try {
      const currentChatAgent = await get(currentChatAgent$);
      signal.throwIfAborted();
      if (currentChatAgent) {
        const src = resolveAvatarUrl(currentChatAgent.avatarUrl);
        if (src) {
          await fetch(src, { signal });
        }
      }
    } catch (error) {
      throwIfAbort(error);
      // non-fatal prefetch failure — skeleton hides regardless
    }
    set(internalVisible$, false);
  },
);
