import { command, computed, state } from "ccstate";
import { currentChatAgent$ } from "./agent-chat";
import { resolveAvatarUrl } from "../views/zero-page/avatar-utils";
import { pinnedAgents$ } from "./zero-page/zero-pinned-agents";

const internalVisible$ = state(true);

export const appSkeletonVisible$ = computed((get) => {
  return get(internalVisible$);
});

export const showAppSkeleton$ = command(({ set }) => {
  set(internalVisible$, true);
});

export const hideAppSkeleton$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    await Promise.allSettled([
      (async () => {
        const currentChatAgent = await get(currentChatAgent$);
        signal.throwIfAborted();
        if (currentChatAgent) {
          const src = resolveAvatarUrl(currentChatAgent.avatarUrl);
          if (src) {
            await fetch(src, {
              signal,
            });
          }
        }
      })(),
      get(pinnedAgents$),
    ]);
    signal.throwIfAborted();
    set(internalVisible$, false);
  },
);
