import { command, computed, state } from "ccstate";
import { fetch$ } from "../fetch.ts";
import { downloadArtifact } from "../artifact-download.ts";

// ---------------------------------------------------------------------------
// Artifact list
// ---------------------------------------------------------------------------

export interface ArtifactItem {
  name: string;
  size: number;
  fileCount: number;
  updatedAt: string;
}

const internalArtifacts$ = state<ArtifactItem[]>([]);
const internalLoading$ = state(false);
const internalError$ = state<string | null>(null);

export const zeroArtifacts$ = computed((get) => get(internalArtifacts$));
export const zeroArtifactsLoading$ = computed((get) => get(internalLoading$));
export const zeroArtifactsError$ = computed((get) => get(internalError$));

export const fetchZeroArtifacts$ = command(async ({ get, set }) => {
  set(internalLoading$, true);
  set(internalError$, null);

  const fetchFn = get(fetch$);
  const resp = await fetchFn("/api/storages/list?type=artifact");

  if (!resp.ok) {
    set(internalLoading$, false);
    set(internalError$, "Failed to load documents.");
    return;
  }

  const data = (await resp.json()) as ArtifactItem[];
  set(internalArtifacts$, data);
  set(internalLoading$, false);
});

// ---------------------------------------------------------------------------
// Download artifact
// ---------------------------------------------------------------------------

export const downloadArtifact$ = command(
  async ({ get }, params: { name: string }) => {
    const fetchFn = get(fetch$);
    await downloadArtifact(fetchFn, params);
  },
);
