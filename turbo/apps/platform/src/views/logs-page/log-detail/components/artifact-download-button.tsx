import { useSet, useLoadable } from "ccstate-react";
import { IconDownload } from "@tabler/icons-react";
import {
  downloadArtifact$,
  artifactDownloadPromise$,
} from "../../../../signals/logs-page/logs-signals.ts";
import { detach, Reason } from "../../../../signals/utils.ts";

export function ArtifactDownloadButton({
  name,
  version,
}: {
  name: string;
  version: string;
}) {
  const download = useSet(downloadArtifact$);
  const downloadStatus = useLoadable(artifactDownloadPromise$);

  const isLoading = downloadStatus.state === "loading";
  const hasError = downloadStatus.state === "hasError";
  const errorMessage =
    hasError && downloadStatus.error instanceof Error
      ? downloadStatus.error.message
      : hasError
        ? "Download failed"
        : null;

  const handleDownload = () => {
    detach(download({ name, version: version }), Reason.DomCallback);
  };

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleDownload}
        disabled={isLoading}
        className="inline-flex items-center gap-1.5 text-sm text-foreground hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed"
        title="Download artifact"
      >
        <span className="whitespace-nowrap">Download</span>
        <IconDownload className="h-4 w-4 text-muted-foreground" />
      </button>
      {errorMessage && (
        <span className="text-xs text-destructive">{errorMessage}</span>
      )}
    </div>
  );
}
