import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { useGet, useSet } from "ccstate-react";
import { findWebsiteTemplateItem, type WebsiteTemplateItem } from "@vm0/core";
import {
  closeWebsiteTemplatePreview$,
  websiteTemplatePreviewId$,
} from "../../signals/zero-page/zero-chat-composer.ts";

function WebsiteTemplatePreviewDialog({
  item,
  open,
  onOpenChange,
}: {
  item: WebsiteTemplateItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (item === null) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="flex h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[1120px] flex-col gap-0 overflow-hidden p-0 [&>button[aria-label=Close]]:top-[7px] sm:h-[min(760px,calc(100dvh-4rem))]"
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
          <div className="h-full overflow-hidden rounded-lg border border-border bg-background">
            <iframe
              title={`${item.title} website full preview`}
              src={item.previewUrl}
              sandbox="allow-same-origin allow-scripts"
              className="h-full w-full border-0 bg-background"
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

  return (
    <WebsiteTemplatePreviewDialog
      item={item}
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) {
          closePreview();
        }
      }}
    />
  );
}
