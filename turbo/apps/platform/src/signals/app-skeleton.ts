import { command, computed, state, type Command, type Computed } from "ccstate";
import { currentChatAgent$ } from "./agent-chat.ts";
import { resolveAvatarUrl } from "../views/zero-page/avatar-utils.ts";
import { resetSignal, bestEffort, setLoop } from "./utils.ts";
import { agents$ } from "./agent.ts";

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

const internalVisible$ = state(true);

// ---------------------------------------------------------------------------
// Message cycling
// ---------------------------------------------------------------------------

const LOADING_MESSAGES = [
  "Warming up the neurons...",
  "Brewing some ideas...",
  "Getting things ready...",
  "Almost there...",
  "Loading your workspace...",
  "Tuning the instruments...",
  "Connecting the dots...",
  "Spinning up the team...",
] as const;

const skeletonMsgIndex$ = state(
  Math.floor(Math.random() * LOADING_MESSAGES.length),
);

const skeletonFirstCycle$ = state(true);

const resetSkeletonCycling$ = resetSignal();

export const skeletonMessages$ = computed((get) => {
  const i = get(skeletonMsgIndex$);
  const len = LOADING_MESSAGES.length;
  return {
    staticMsg: LOADING_MESSAGES[i % len],
    typewriterMsg: LOADING_MESSAGES[(i + 1) % len],
    isFirst: get(skeletonFirstCycle$),
    cycle: i,
  };
});

const cycleSkeletonMessage$ = command(({ set }) => {
  set(skeletonFirstCycle$, false);
  set(skeletonMsgIndex$, (prev) => {
    return prev + 1;
  });
});

export const startSkeletonCycling$ = command(
  async ({ set }, parentSignal: AbortSignal) => {
    await setLoop(
      () => {
        set(cycleSkeletonMessage$);
        return false;
      },
      4000,
      set(resetSkeletonCycling$, parentSignal),
    );
  },
);

export const appSkeletonVisible$ = computed((get) => {
  return get(internalVisible$);
});

export const showAppSkeleton$ = command(({ set }) => {
  set(internalVisible$, true);
});

const prefetch$ = command(
  async (
    { get, set },
    fn$: Command<Promise<unknown>, [AbortSignal]> | Computed<Promise<unknown>>,
    signal: AbortSignal,
  ) => {
    await bestEffort("read" in fn$ ? get(fn$) : set(fn$, signal));
  },
);

const prefetchAvatar$ = command(async ({ get }, signal: AbortSignal) => {
  const currentChatAgent = await get(currentChatAgent$);
  signal.throwIfAborted();
  if (!currentChatAgent) {
    return;
  }
  const src = resolveAvatarUrl(currentChatAgent.avatarUrl);
  if (!src) {
    return;
  }
  await fetch(src, { signal });
});

export const hideAppSkeleton$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(resetSkeletonCycling$);

    await Promise.all([
      set(prefetch$, prefetchAvatar$, signal),
      set(prefetch$, agents$, signal),
    ]);
    signal.throwIfAborted();

    set(internalVisible$, false);
  },
);
