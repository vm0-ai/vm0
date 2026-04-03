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

// -- Upload avatar command --------------------------------------------------

export const uploadJobsAvatar$ = command(
  async (
    { set },
    file: File,
    fetchFn: (
      url: string | URL | Request,
      options?: RequestInit,
    ) => Promise<Response>,
    _signal: AbortSignal,
  ): Promise<void> => {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetchFn("/api/zero/uploads", {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      throw new Error(`Upload failed (${res.status})`);
    }
    const data: { url: string } = await res.json();
    set(internalAvatarUrl$, data.url);
  },
);

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
  set(internalAvatarUrl$, randomPresetAvatar());
});
