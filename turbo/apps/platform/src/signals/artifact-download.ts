import type { ArtifactDownloadResponse } from "@vm0/core";

/**
 * Fetches a presigned download URL for the given artifact and opens it in a
 * new browser tab.
 *
 * This is intentionally a plain async function (not a ccstate command) so it
 * can be reused by different signal modules that each have their own state
 * management around downloads.
 */
export async function downloadArtifact(
  fetchFn: (url: string) => Promise<Response>,
  params: { name: string; version?: string },
): Promise<void> {
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
}
