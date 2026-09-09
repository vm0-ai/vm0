import type { AttachmentDisplay } from "../../signals/attachment-resource-url.ts";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { resolveOfficeDocumentViewerBaseUrl } from "../../lib/platform-host.ts";
import { AutoFocusedArtifactIframe } from "./auto-focused-artifact-iframe.tsx";
import { useAttachmentUrls } from "./attachment-resource.ts";

function officeDocumentViewerUrl(sourceUrl: string): string {
  const viewerUrl = new URL(resolveOfficeDocumentViewerBaseUrl());
  viewerUrl.searchParams.set("src", sourceUrl);
  return viewerUrl.toString();
}

export function OfficeDocumentPreview({
  resourceDisplay,
  filename,
  focusKey,
  focusOnMount,
  testId,
  url,
}: {
  resourceDisplay?: AttachmentDisplay;
  filename: string;
  focusKey: string;
  focusOnMount: boolean;
  testId: string;
  url: string;
}) {
  const { t } = useTranslation();
  const attachmentUrls = useAttachmentUrls(url, resourceDisplay);

  if (attachmentUrls === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }

  // Private documents give the viewer only the expiring resource URL.
  // Historical public documents keep their existing viewer URL.
  return (
    <AutoFocusedArtifactIframe
      focusKey={focusKey}
      focusOnMount={focusOnMount}
      src={officeDocumentViewerUrl(
        attachmentUrls.shareUrl ?? attachmentUrls.resourceUrl,
      )}
      title={t(
        ($) => {
          return $.artifacts.preview.dialogLabel;
        },
        { filename },
      )}
      referrerPolicy="no-referrer"
      scrolling="yes"
      allowFullScreen
      className="block h-full min-h-0 w-full border-0 bg-background"
      data-testid={testId}
    />
  );
}
