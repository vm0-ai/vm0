import { command, computed, state } from "ccstate";
import { onRef, resetSignal, setLoop } from "./utils.ts";
import { getAvatarPresets } from "../views/zero-page/zero-avatars.ts";
import { captureFirstSkeletonHide$ } from "../lib/posthog.ts";
import { i18n } from "../i18n/index.ts";
import { locale$ } from "./locale.ts";

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

const internalVisible$ = state(true);

const APP_SKELETON_VISIBLE_EVENT = "vm0:app-skeleton-visible";
const APP_SKELETON_VISIBLE_EVENT_QUEUED_KEY =
  "vm0AppSkeletonVisibleEventQueued";
const APP_BOOTSTRAP_SKELETON_ID = "app-bootstrap-skeleton";
const APP_BOOTSTRAP_SKELETON_HIDDEN_CLASS = "app-bootstrap-skeleton--hidden";

const internalBootstrapSkeletonActive$ = state(false);

export const bootstrapSkeletonActive$ = computed((get) => {
  return get(internalBootstrapSkeletonActive$);
});

export const initBootstrapSkeleton$ = command(({ set }) => {
  const active = document.getElementById(APP_BOOTSTRAP_SKELETON_ID) !== null;
  if (active) {
    queueAppSkeletonVisibleEvent();
  }
  set(internalBootstrapSkeletonActive$, active);
});

function queueAppSkeletonVisibleEvent(): void {
  if (
    document.documentElement.dataset[APP_SKELETON_VISIBLE_EVENT_QUEUED_KEY] ===
    "true"
  ) {
    return;
  }
  document.documentElement.dataset[APP_SKELETON_VISIBLE_EVENT_QUEUED_KEY] =
    "true";
  queueMicrotask(() => {
    window.dispatchEvent(new Event(APP_SKELETON_VISIBLE_EVENT));
  });
}

export const appSkeletonVisibleEventRef$ = onRef(
  command((_visitor, _element: HTMLDivElement, _signal: AbortSignal) => {
    queueAppSkeletonVisibleEvent();
  }),
);

function hideBootstrapSkeleton(): void {
  const skeleton = document.getElementById(APP_BOOTSTRAP_SKELETON_ID);
  if (!skeleton) {
    return;
  }
  skeleton.setAttribute("aria-hidden", "true");
  skeleton.addEventListener(
    "transitionend",
    () => {
      skeleton.remove();
    },
    { once: true },
  );
  skeleton.classList.add(APP_BOOTSTRAP_SKELETON_HIDDEN_CLASS);
}

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

const LOADING_COPY_COUNT = 8;

const skeletonCopyIndex$ = state(
  Math.floor(Math.random() * LOADING_COPY_COUNT),
);

const skeletonFirstCycle$ = state(true);

const resetSkeletonCycling$ = resetSignal();

export const skeletonCopy$ = computed((get) => {
  get(locale$);
  const loadingCopy = [
    i18n.t(($) => {
      return $.appShell.loading.messages.warmingNeurons;
    }),
    i18n.t(($) => {
      return $.appShell.loading.messages.brewingIdeas;
    }),
    i18n.t(($) => {
      return $.appShell.loading.messages.gettingReady;
    }),
    i18n.t(($) => {
      return $.appShell.loading.messages.almostThere;
    }),
    i18n.t(($) => {
      return $.appShell.loading.messages.loadingWorkspace;
    }),
    i18n.t(($) => {
      return $.appShell.loading.messages.tuningInstruments;
    }),
    i18n.t(($) => {
      return $.appShell.loading.messages.connectingDots;
    }),
    i18n.t(($) => {
      return $.appShell.loading.messages.spinningTeam;
    }),
  ];
  const i = get(skeletonCopyIndex$);
  const len = loadingCopy.length;
  return {
    ariaLabel: i18n.t(($) => {
      return $.appShell.loading.ariaLabel;
    }),
    staticCopy: loadingCopy[i % len],
    typewriterCopy: loadingCopy[(i + 1) % len],
    isFirst: get(skeletonFirstCycle$),
    cycle: i,
  };
});

const cycleSkeletonCopy$ = command(({ set }) => {
  set(skeletonFirstCycle$, false);
  set(skeletonCopyIndex$, (prev) => {
    return prev + 1;
  });
});

const MAX_SKELETON_CYCLES = 3;

export const startSkeletonCycling$ = command(
  async ({ set }, parentSignal: AbortSignal) => {
    let cycles = 0;
    await setLoop(
      () => {
        set(cycleSkeletonCopy$);
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

  set(internalBootstrapSkeletonActive$, false);
  set(internalVisible$, false);
  hideBootstrapSkeleton();
  set(captureFirstSkeletonHide$);
});
