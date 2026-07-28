import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { useGet, useSet } from "ccstate-react";
import {
  findWebsiteTemplateItem,
  r2ImageTransformUrl,
  type WebsiteTemplateItem,
} from "@vm0/core";
import {
  closeWebsiteTemplatePreview$,
  markWebsiteTemplatePreviewLoaded$,
  websiteTemplatePreviewId$,
  websiteTemplatePreviewLoaded$,
} from "../../signals/zero-page/zero-chat-composer.ts";

function WebsiteTemplatePreviewDialog({
  item,
  open,
  onOpenChange,
}: {
  item: WebsiteTemplateItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const previewLoaded = useGet(websiteTemplatePreviewLoaded$);
  const markPreviewLoaded = useSet(markWebsiteTemplatePreviewLoaded$);
  const placeholderUrl = r2ImageTransformUrl(item.previewImageUrl, {
    width: 480,
    height: 270,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="flex h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[1120px] flex-col gap-0 overflow-hidden p-0 data-[state=open]:!animate-none [&>button[aria-label=Close]]:top-[7px] sm:h-[min(760px,calc(100dvh-4rem))]"
        overlayClassName="data-[state=open]:!animate-none"
      >
        <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-14 text-left sm:pr-16">
          <DialogTitle className="flex min-w-0 max-w-full items-center justify-start gap-1.5 text-left text-base leading-none">
            <button
              type="button"
              className="inline-flex shrink-0 items-center p-0 leading-none text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Website
            </button>
            <span className="shrink-0 text-muted-foreground">/</span>
            <span className="block min-w-0 truncate leading-none">
              {item.title}
            </span>
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 bg-muted/20 p-3 sm:p-5">
          <div className="relative h-full overflow-hidden rounded-lg border border-border bg-background">
            <img
              src={placeholderUrl}
              alt=""
              aria-hidden="true"
              title={`${item.title} website preview placeholder`}
              className={`pointer-events-none absolute inset-0 z-10 h-full w-full bg-background object-contain object-top ${
                previewLoaded ? "hidden" : "block"
              }`}
            />
            <iframe
              title={`${item.title} website full preview`}
              src={item.previewUrl}
              sandbox="allow-same-origin allow-scripts"
              className="h-full w-full border-0 bg-background"
              onLoad={markPreviewLoaded}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function WebsiteTemplatePreviewDialogSlot() {
  const previewId = useGet(websiteTemplatePreviewId$);
  const closePreview = useSet(closeWebsiteTemplatePreview$);
  const item =
    previewId === null ? null : (findWebsiteTemplateItem(previewId) ?? null);

  if (item === null) {
    return null;
  }

  return (
    <WebsiteTemplatePreviewDialog
      item={item}
      open
      onOpenChange={(open) => {
        if (!open) {
          closePreview();
        }
      }}
    />
  );
}
