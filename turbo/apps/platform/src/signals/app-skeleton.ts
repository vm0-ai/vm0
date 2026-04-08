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

const FIRST_CYCLE_MS = 5300;
const CYCLE_MS = 4500;

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
    await delay(isFirst ? FIRST_CYCLE_MS : CYCLE_MS, { signal });
    while (true) {
      set(cycleSkeletonMessage$);
      await delay(CYCLE_MS, { signal });
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
    }

    set(internalVisible$, false);
  },
);
