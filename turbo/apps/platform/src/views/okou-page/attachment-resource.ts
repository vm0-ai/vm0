import type { Computed } from "ccstate";
import { useLastResolved } from "ccstate-react";
import {
  emptyAttachmentUrls$,
  type AttachmentUrls,
} from "../../signals/attachment-resource-url.ts";

export function useAttachmentUrls(
  urls$?: Computed<Promise<AttachmentUrls | null>> | null,
): AttachmentUrls | undefined {
  return useLastResolved(urls$ ?? emptyAttachmentUrls$) ?? undefined;
}

export function useResolvedAttachmentUrl(
  urls$?: Computed<Promise<AttachmentUrls | null>> | null,
): string | null {
  return useAttachmentUrls(urls$)?.resourceUrl ?? null;
}
