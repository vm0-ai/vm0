import { command, computed, state } from "ccstate";
import type { ArtifactDownloadResponse } from "@vm0/core";
import { fetch$ } from "../fetch.ts";

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
    const searchParams = new URLSearchParams({ name: params.name });

    const response = await fetchFn(
      `/api/platform/artifacts/download?${searchParams.toString()}`,
    );

    if (!response.ok) {
      const errorData = (await response.json()) as {
        error?: { message?: string };
      };
      throw new Error(errorData.error?.message ?? "Failed to get download URL");
    }

    const data = (await response.json()) as ArtifactDownloadResponse;

    if (!data.url) {
      throw new Error("Download URL not provided by server");
    }

    const opened = window.open(data.url, "_blank");
    if (!opened || opened.closed || typeof opened.closed === "undefined") {
      throw new Error(
        "Download blocked by browser. Please allow popups for this site.",
      );
    }
  },
);
