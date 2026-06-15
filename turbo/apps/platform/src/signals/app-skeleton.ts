import { command, computed, state } from "ccstate";
import { resetSignal, setLoop } from "./utils.ts";
import { getAvatarPresets } from "../views/zero-page/zero-avatars.ts";
import { captureFirstSkeletonHide$ } from "../lib/posthog.ts";

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

const internalVisible$ = state(true);

// ---------------------------------------------------------------------------
// Avatar – picked once at module load so remounts don't flicker
// ---------------------------------------------------------------------------

const internalSkeletonAvatar$ = state(
  (() => {
    const presets = getAvatarPresets();
    return presets[Math.floor(Math.random() * presets.length)];
  })(),
);

export const skeletonAvatarConfig$ = computed((get) => {
  return get(internalSkeletonAvatar$);
});

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

const MAX_SKELETON_CYCLES = 3;

export const startSkeletonCycling$ = command(
  async ({ set }, parentSignal: AbortSignal) => {
    let cycles = 0;
    await setLoop(
      () => {
        set(cycleSkeletonMessage$);
        return ++cycles >= MAX_SKELETON_CYCLES;
      },
      4000,
      set(resetSkeletonCycling$, parentSignal),
    );
  },
);

export const appSkeletonVisible$ = computed((get) => {
  return get(internalVisible$);
});

/**
 * Reveal the skeleton and reset the typewriter intro. `hideAppSkeleton$`
 * aborts the cycling loop via `resetSkeletonCycling$`; if the caller needs
 * the typewriter animation to play after a re-show (e.g. the brief
 * skeleton between onboarding completion and the chat page), it must
 * restart the cycling itself by awaiting `startSkeletonCycling$` in its
 * own async context.
 */
export const showAppSkeleton$ = command(({ set }) => {
  set(internalVisible$, true);
  set(skeletonFirstCycle$, true);
});

export const hideAppSkeleton$ = command(({ set }, _signal: AbortSignal) => {
  set(resetSkeletonCycling$);

  set(internalVisible$, false);
  set(captureFirstSkeletonHide$);
});
