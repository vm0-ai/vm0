import { computed, type Computed } from "ccstate";
import {
  createCardSignalsRegistry,
  type CardSignalsRegistry,
} from "./card-signal-map.ts";
import {
  createTextPreviewComputed,
  isTextPreviewKind,
} from "../text-preview.ts";
import { createAttachmentResourceUrl$ } from "../attachment-resource-url.ts";

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
  readonly previewImageUrl$: Computed<Promise<string | undefined>>;
  readonly resourceUrl$: Computed<Promise<string>>;
  readonly text$?: Computed<Promise<string>>;
}

export type ArtifactCardSignalsRegistry = CardSignalsRegistry<
  ArtifactDescriptor,
  ArtifactSignals
>;

function needsTextPreview(kind: ArtifactKind): boolean {
  return isTextPreviewKind(kind);
}

function createArtifactSignals(
  descriptor: ArtifactDescriptor,
  previewImageUrlsByUrl$: Computed<Promise<ReadonlyMap<string, string>>>,
): ArtifactSignals {
  const resourceUrl$ = createAttachmentResourceUrl$(descriptor.url);
  const previewImageUrl$ = computed(async (get) => {
    if (descriptor.kind !== "html" && descriptor.kind !== "video") {
      return undefined;
    }
    const previewImageUrlsByUrl = await get(previewImageUrlsByUrl$);
    return previewImageUrlsByUrl.get(descriptor.url);
  });
  if (!needsTextPreview(descriptor.kind)) {
    return { ...descriptor, previewImageUrl$, resourceUrl$ };
  }
  return {
    ...descriptor,
    previewImageUrl$,
    resourceUrl$,
    text$: createTextPreviewComputed(descriptor.url),
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
