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

const APP_SKELETON_VISIBLE_EVENT = "vm0:app-skeleton-visible";
const APP_SKELETON_VISIBLE_EVENT_QUEUED_KEY =
  "vm0AppSkeletonVisibleEventQueued";
const APP_FIRST_CONTENT_VISIBLE_EVENT = "vm0:app-first-content-visible";
const APP_FIRST_CONTENT_VISIBLE_EVENT_DISPATCHED_KEY =
  "vm0AppFirstContentVisibleEventDispatched";
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
  set(internalOverlayMounted$, !active);
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

export const firstAppContentVisibleEventRef$ = onRef(
  command((_visitor, _element: HTMLSpanElement, _signal: AbortSignal) => {
    if (
      document.documentElement.dataset[
        APP_FIRST_CONTENT_VISIBLE_EVENT_DISPATCHED_KEY
      ] === "true"
    ) {
      return;
    }
    document.documentElement.dataset[
      APP_FIRST_CONTENT_VISIBLE_EVENT_DISPATCHED_KEY
    ] = "true";
    window.dispatchEvent(new Event(APP_FIRST_CONTENT_VISIBLE_EVENT));
  }),
);

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
