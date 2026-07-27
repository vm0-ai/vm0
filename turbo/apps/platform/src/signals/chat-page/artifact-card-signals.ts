import { computed, type Computed } from "ccstate";
import {
  getOrCreateCardSignals,
  registeredCardSignals,
} from "./card-signal-map.ts";
import {
  createTextPreviewComputed,
  isTextPreviewKind,
} from "../text-preview.ts";

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
  readonly text$?: Computed<Promise<string>>;
}

export interface ArtifactCardSignalsRegistry {
  register(descriptor: ArtifactDescriptor): ArtifactSignals;
  resolve(resourceKey: string): ArtifactSignals;
  find(resourceKey: string): ArtifactSignals | undefined;
}

function needsTextPreview(kind: ArtifactKind): boolean {
  return isTextPreviewKind(kind);
}

function createArtifactSignals(
  descriptor: ArtifactDescriptor,
  previewImageUrlsByUrl$: Computed<Promise<ReadonlyMap<string, string>>>,
): ArtifactSignals {
  const previewImageUrl$ = computed(async (get) => {
    if (descriptor.kind !== "html" && descriptor.kind !== "video") {
      return undefined;
    }
    const previewImageUrlsByUrl = await get(previewImageUrlsByUrl$);
    return previewImageUrlsByUrl.get(descriptor.url);
  });
  if (!needsTextPreview(descriptor.kind)) {
    return { ...descriptor, previewImageUrl$ };
  }
  return {
    ...descriptor,
    previewImageUrl$,
    text$: createTextPreviewComputed(descriptor.url),
  };
}

export function createArtifactCardSignalsRegistry(
  previewImageUrlsByUrl$: Computed<Promise<ReadonlyMap<string, string>>>,
): ArtifactCardSignalsRegistry {
  const signalsByResourceKey = new Map<string, ArtifactSignals>();
  return {
    register(descriptor) {
      return getOrCreateCardSignals(
        signalsByResourceKey,
        descriptor.url,
        () => {
          return createArtifactSignals(descriptor, previewImageUrlsByUrl$);
        },
      );
    },
    resolve(resourceKey) {
      return registeredCardSignals(signalsByResourceKey, resourceKey);
    },
    find(resourceKey) {
      return signalsByResourceKey.get(resourceKey);
    },
  };
}
