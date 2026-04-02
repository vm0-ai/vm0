import { command, computed, state } from "ccstate";
import { randomPresetAvatar } from "../../views/zero-page/avatar-utils.ts";

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

// -- Avatar -----------------------------------------------------------------

const internalAvatarUrl$ = state(randomPresetAvatar());
export const jobsAvatarUrl$ = computed((get) => {
  return get(internalAvatarUrl$);
});
export const setJobsAvatarUrl$ = command(({ set }, url: string) => {
  set(internalAvatarUrl$, url);
});
export const resetJobsAvatarUrl$ = command(({ set }) => {
  set(internalAvatarUrl$, randomPresetAvatar());
});

// -- File input ref ---------------------------------------------------------

const internalFileInputEl$ = state<HTMLInputElement | null>(null);
export const jobsFileInputEl$ = computed((get) => {
  return get(internalFileInputEl$);
});
export const setJobsFileInputEl$ = command(
  ({ set }, el: HTMLInputElement | null) => {
    set(internalFileInputEl$, el);
  },
);

// -- Avatar upload loading --------------------------------------------------

const internalUploading$ = state(false);
export const jobsUploading$ = computed((get) => {
  return get(internalUploading$);
});
export const setJobsUploading$ = command(({ set }, uploading: boolean) => {
  set(internalUploading$, uploading);
});

// -- Create loading ---------------------------------------------------------

const internalCreating$ = state(false);
export const jobsCreating$ = computed((get) => {
  return get(internalCreating$);
});
export const setJobsCreating$ = command(({ set }, creating: boolean) => {
  set(internalCreating$, creating);
});

// -- Reset dialog state on close --------------------------------------------

export const resetJobsDialog$ = command(({ set }) => {
  set(internalNewName$, "");
  set(internalAvatarUrl$, randomPresetAvatar());
});
