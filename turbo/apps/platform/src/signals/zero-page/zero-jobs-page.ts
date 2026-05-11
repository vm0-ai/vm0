import { command, computed, state } from "ccstate";
import {
  randomAvatarSvgConfig,
  serializeAvatarSvgConfig,
} from "../../views/zero-page/avatar-svg-utils.ts";

function randomSvgAvatarUrl(): string {
  return serializeAvatarSvgConfig(randomAvatarSvgConfig());
}

// ---------------------------------------------------------------------------
// Create-teammate dialog state
// ---------------------------------------------------------------------------

const internalDialogOpen$ = state(false);
export const jobsDialogOpen$ = computed((get) => {
  return get(internalDialogOpen$);
});
export const setJobsDialogOpen$ = command(({ set }, open: boolean) => {
  set(internalDialogOpen$, open);
});

const internalNewName$ = state("");
export const jobsNewName$ = computed((get) => {
  return get(internalNewName$);
});
export const setJobsNewName$ = command(({ set }, name: string) => {
  set(internalNewName$, name);
});

// -- Visibility -------------------------------------------------------------

const internalVisibility$ = state<"public" | "private">("public");
export const jobsVisibility$ = computed((get) => {
  return get(internalVisibility$);
});
export const setJobsVisibility$ = command(
  ({ set }, visibility: "public" | "private") => {
    set(internalVisibility$, visibility);
  },
);

// -- Avatar -----------------------------------------------------------------

const internalAvatarUrl$ = state(randomSvgAvatarUrl());
export const jobsAvatarUrl$ = computed((get) => {
  return get(internalAvatarUrl$);
});
export const setJobsAvatarUrl$ = command(({ set }, url: string) => {
  set(internalAvatarUrl$, url);
});

// -- View mode (grid / list) ------------------------------------------------

const internalViewMode$ = state<"grid" | "list">("grid");
export const jobsViewMode$ = computed((get) => {
  return get(internalViewMode$);
});
export const setJobsViewMode$ = command(({ set }, mode: "grid" | "list") => {
  set(internalViewMode$, mode);
});

// -- Reset dialog state on close --------------------------------------------

export const resetJobsDialog$ = command(({ set }) => {
  set(internalNewName$, "");
  set(internalVisibility$, "public");
  set(internalAvatarUrl$, randomSvgAvatarUrl());
});
