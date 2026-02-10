import { computed, command, state } from "ccstate";
import type {
  LogDetail,
  AgentEvent,
  AgentEventsResponse,
  ArtifactDownloadResponse,
} from "./types.ts";
import { fetch$ } from "../fetch.ts";
import { currentLogId$ } from "./log-detail-state.ts";

const AGENT_EVENTS_PAGE_LIMIT = 30;

/**
 * Async computed that fetches log detail for the current logId.
 * Re-evaluates automatically when currentLogId$ changes.
 */
export const runDetail$ = computed(async (get) => {
  const logId = get(currentLogId$);
  if (!logId) {
    return null;
  }

  const fetchFn = get(fetch$);
  const response = await fetchFn(`/api/platform/logs/${logId}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch log detail: ${response.statusText}`);
  }
  return (await response.json()) as LogDetail;
});

/**
 * Async computed that fetches ALL agent events for the current logId.
 * Internally paginates through the API until all events are loaded.
 * Re-evaluates automatically when currentLogId$ changes.
 */
export const runEvents$ = computed(async (get, { signal }) => {
  const logId = get(currentLogId$);
  if (!logId) {
    return [] as AgentEvent[];
  }

  const fetchFn = get(fetch$);
  const allEvents: AgentEvent[] = [];
  let hasMore = true;
  let since: string | undefined;

  while (hasMore) {
    signal.throwIfAborted();

    const params = new URLSearchParams({
      limit: String(AGENT_EVENTS_PAGE_LIMIT),
      order: "asc",
    });
    if (since) {
      params.set("since", since);
    }

    const response = await fetchFn(
      `/api/agent/runs/${logId}/telemetry/agent?${params.toString()}`,
      { signal },
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch agent events: ${response.statusText}`);
    }

    const data = (await response.json()) as AgentEventsResponse;
    signal.throwIfAborted();

    allEvents.push(...data.events);
    hasMore = data.hasMore;

    if (data.events.length > 0) {
      since = String(
        new Date(data.events[data.events.length - 1].createdAt).getTime(),
      );
    } else {
      hasMore = false;
    }
  }

  return allEvents;
});

// State for tracking current artifact download promise
const internalArtifactDownloadPromise$ = state<Promise<void> | null>(null);

/**
 * Exported computed for artifact download status
 */
export const artifactDownloadPromise$ = computed((get) =>
  get(internalArtifactDownloadPromise$),
);

/**
 * Command to download artifact.
 * Fetches the presigned URL and triggers a download.
 */
export const downloadArtifact$ = command(
  ({ get, set }, params: { name: string; version?: string }): Promise<void> => {
    const downloadPromise = (async () => {
      const fetchFn = get(fetch$);
      const searchParams = new URLSearchParams({ name: params.name });
      if (params.version) {
        searchParams.set("version", params.version);
      }

      const response = await fetchFn(
        `/api/platform/artifacts/download?${searchParams.toString()}`,
      );

      if (!response.ok) {
        const errorData = (await response.json()) as {
          error?: { message?: string };
        };
        throw new Error(
          errorData.error?.message ?? `Failed to get download URL`,
        );
      }

      const data = (await response.json()) as ArtifactDownloadResponse;

      // Validate URL before attempting to open
      if (!data.url) {
        throw new Error("Download URL not provided by server");
      }

      // Trigger download by opening the presigned URL
      const opened = window.open(data.url, "_blank");

      // Check if popup was blocked
      if (!opened || opened.closed || typeof opened.closed === "undefined") {
        throw new Error(
          "Download blocked by browser. Please allow popups for this site.",
        );
      }
    })();

    set(internalArtifactDownloadPromise$, downloadPromise);

    // Clear promise after completion (success or failure)
    downloadPromise
      .finally(() => {
        set(internalArtifactDownloadPromise$, null);
      })
      .catch(() => {
        // Error is already handled in the main promise chain
      });

    return downloadPromise;
  },
);
