import { command, computed, state } from "ccstate";
import { delay } from "signal-timers";
import { currentChatAgent$ } from "./agent-chat.ts";
import { resolveAvatarUrl } from "../views/zero-page/avatar-utils.ts";
import { resetSignal, throwIfAbort } from "./utils.ts";

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

const firstCycleMs$ = state(5300);
const cycleMs$ = state(4500);

/** Override cycling delays — use in tests to avoid real timers. */
export const setCycleDelaysMs$ = command(
  ({ set }, firstMs: number, ms: number) => {
    set(firstCycleMs$, firstMs);
    set(cycleMs$, ms);
  },
);

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
  async ({ get, set }, parentSignal: AbortSignal) => {
    const signal = set(resetSkeletonCycling$, parentSignal);
    const isFirst = get(skeletonFirstCycle$);
    await delay(isFirst ? get(firstCycleMs$) : get(cycleMs$), { signal });
    while (true) {
      set(cycleSkeletonMessage$);
      await delay(get(cycleMs$), { signal });
    }
  },
);

export const appSkeletonVisible$ = computed((get) => {
  return get(internalVisible$);
});

export const showAppSkeleton$ = command(({ set }) => {
  set(internalVisible$, true);
});

export const hideAppSkeleton$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(resetSkeletonCycling$);

    // Avatar prefetch is a best-effort cache warm-up: a missing or
    // unavailable agent should not prevent the skeleton from hiding.
    // eslint-disable-next-line no-restricted-syntax -- best-effort avatar prefetch: failures must not prevent the skeleton from hiding
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
    }

    set(internalVisible$, false);
  },
);
