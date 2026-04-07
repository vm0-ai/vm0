import { command, computed, state } from "ccstate";
import { currentChatAgent$ } from "./agent-chat.ts";
import { resolveAvatarUrl } from "../views/zero-page/avatar-utils.ts";

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
    const currentChatAgent = await get(currentChatAgent$).catch(() => {
      return null;
    });
    signal.throwIfAborted();
    if (currentChatAgent) {
      const src = resolveAvatarUrl(currentChatAgent.avatarUrl);
      if (src) {
        // best-effort prefetch — fetch failure is non-fatal
        await fetch(src, { signal }).catch(() => {
          return undefined;
        });
      }
    }
    set(internalVisible$, false);
  },
);
