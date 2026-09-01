import { command, computed, state } from "ccstate";
import { onRef } from "./utils.ts";
import {
  captureBootstrapPhaseTiming$,
  captureFirstSkeletonHide$,
} from "../lib/posthog.ts";

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

const internalVisible$ = state(true);
const internalOverlayMounted$ = state(true);

const APP_BOOTSTRAP_SKELETON_ID = "app-bootstrap-skeleton";
const APP_BOOTSTRAP_SKELETON_HIDDEN_CLASS = "app-bootstrap-skeleton--hidden";

const internalBootstrapSkeletonActive$ = state(false);

export const bootstrapSkeletonActive$ = computed((get) => {
  return get(internalBootstrapSkeletonActive$);
});

export const initBootstrapSkeleton$ = command(({ set }) => {
  const active = document.getElementById(APP_BOOTSTRAP_SKELETON_ID) !== null;
  set(internalOverlayMounted$, !active);
  set(internalBootstrapSkeletonActive$, active);
});

export function hideBootstrapSkeleton(): void {
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

export const appSkeletonVisible$ = computed((get) => {
  return get(internalVisible$);
});

export const appSkeletonOverlayMounted$ = computed((get) => {
  return get(internalOverlayMounted$);
});

export const unmountAppSkeletonOverlay$ = command(({ get, set }) => {
  if (!get(internalVisible$)) {
    set(internalOverlayMounted$, false);
  }
});

export const showAppSkeleton$ = command(({ get, set }) => {
  set(internalVisible$, true);
  set(internalOverlayMounted$, !get(internalBootstrapSkeletonActive$));
});

export const hideAppSkeleton$ = command(({ set }, _signal: AbortSignal) => {
  set(internalBootstrapSkeletonActive$, false);
  set(internalVisible$, false);
  hideBootstrapSkeleton();
  set(captureFirstSkeletonHide$);
  set(captureBootstrapPhaseTiming$);
});

export const hideAppSkeletonOnContentReadyRef$ = onRef(
  command(({ set }, _element: HTMLSpanElement, signal: AbortSignal) => {
    set(hideAppSkeleton$, signal);
  }),
);
