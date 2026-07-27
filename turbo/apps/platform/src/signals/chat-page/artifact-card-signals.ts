import { computed, type Computed } from "ccstate";
import {
  getOrCreateCardSignals,
  registeredCardSignals,
} from "./card-signal-map.ts";

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
}

const TEXT_PREVIEW_MAX_BYTES = 65_536;

async function readLimitedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  let reachedLimit = false;

  while (received < TEXT_PREVIEW_MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    const remaining = TEXT_PREVIEW_MAX_BYTES - received;
    const chunk =
      value.byteLength > remaining ? value.slice(0, remaining) : value;
    chunks.push(chunk);
    received += chunk.byteLength;
    if (received >= TEXT_PREVIEW_MAX_BYTES) {
      reachedLimit = true;
      break;
    }
  }

  if (reachedLimit) {
    await reader.cancel();
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function fetchPreviewText(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(url, {
    headers: { Range: `bytes=0-${String(TEXT_PREVIEW_MAX_BYTES - 1)}` },
    signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)}`);
  }
  return readLimitedText(response);
}

function needsTextPreview(kind: ArtifactKind): boolean {
  return kind === "text" || kind === "json";
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
    text$: computed(() => {
      return fetchPreviewText(descriptor.url);
    }),
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
  };
}
