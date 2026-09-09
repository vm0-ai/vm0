import { computed, type Computed } from "ccstate";
import {
  createCardSignalsRegistry,
  type CardSignalsRegistry,
} from "./card-signal-map.ts";
import {
  createTextPreviewComputed,
  isTextPreviewKind,
} from "../text-preview.ts";
import {
  createAttachmentResourceUrl$,
  type AttachmentUrlsComputed,
} from "../attachment-resource-url.ts";
import {
  createImageLoadSignals,
  type ImageLoadSignals,
} from "../image-load.ts";

export type ArtifactKind =
  | "image"
  | "video"
  | "audio"
  | "markdown"
  | "text"
  | "json"
  | "csv"
  | "pdf"
  | "html"
  | "file";

export interface ArtifactDescriptor {
  readonly filename: string;
  readonly url: string;
  readonly kind: ArtifactKind;
}

export interface ArtifactSignals extends ArtifactDescriptor {
  /** Load state of the card's presented image (the image itself, or a poster). */
  readonly previewImageLoad: ImageLoadSignals;
  readonly previewImageUrl$: Computed<Promise<string | undefined>>;
  readonly resourceUrl$: Computed<Promise<string>>;
  readonly attachmentUrls$: AttachmentUrlsComputed;
  readonly text$?: Computed<Promise<string>>;
}

export type ArtifactCardSignalsRegistry = CardSignalsRegistry<
  ArtifactDescriptor,
  ArtifactSignals
>;

export function createArtifactPreviewImageUrls$(
  entries: readonly (readonly [string, string])[],
): Computed<Promise<ReadonlyMap<string, string>>> {
  const previewImageUrlsByUrl = new Map(entries);
  return computed(() => {
    return Promise.resolve(previewImageUrlsByUrl);
  });
}

function needsTextPreview(kind: ArtifactKind): boolean {
  return isTextPreviewKind(kind);
}

function createArtifactSignals(
  descriptor: ArtifactDescriptor,
  previewImageUrlsByUrl$: Computed<Promise<ReadonlyMap<string, string>>>,
): ArtifactSignals {
  const attachmentUrls$ = createAttachmentResourceUrl$(descriptor.url);
  const resourceUrl$ = computed(async (get) => {
    return (await get(attachmentUrls$)).resourceUrl;
  });
  const previewImageLoad = createImageLoadSignals();
  const previewImageUrl$ = computed(async (get) => {
    if (descriptor.kind !== "html" && descriptor.kind !== "video") {
      return undefined;
    }
    const previewImageUrlsByUrl = await get(previewImageUrlsByUrl$);
    const url = previewImageUrlsByUrl.get(descriptor.url);
    return url
      ? (await get(createAttachmentResourceUrl$(url))).resourceUrl
      : undefined;
  });
  if (!needsTextPreview(descriptor.kind)) {
    return {
      ...descriptor,
      previewImageLoad,
      previewImageUrl$,
      resourceUrl$,
      attachmentUrls$,
    };
  }
  return {
    ...descriptor,
    attachmentUrls$,
    previewImageLoad,
    previewImageUrl$,
    resourceUrl$,
    text$: createTextPreviewComputed(descriptor.url, resourceUrl$),
  };
}

export function createArtifactCardSignalsRegistry(
  previewImageUrlsByUrl$: Computed<Promise<ReadonlyMap<string, string>>>,
): ArtifactCardSignalsRegistry {
  return createCardSignalsRegistry(
    (descriptor: ArtifactDescriptor) => {
      return descriptor.url;
    },
    (descriptor) => {
      return createArtifactSignals(descriptor, previewImageUrlsByUrl$);
    },
  );
}
