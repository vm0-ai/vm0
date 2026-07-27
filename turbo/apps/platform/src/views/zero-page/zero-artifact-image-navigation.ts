import type {
  ChatThreadArtifactFile,
  ChatThreadArtifactRun,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  type BodyRenderBlock,
  classifyChatAttachment,
} from "../../signals/chat-page/parse-body-blocks.ts";
import { artifactPreviewUrlsMatch } from "./zero-attachment-url.ts";

export type ImageArtifactNavigationItem = {
  readonly url: string;
  readonly filename: string;
  /**
   * Present when the image is a run artifact (agent-generated / hosted): carries
   * the artifact file and its run so the lightbox keeps full download/share/sync
   * metadata. Absent for human-uploaded images, which resolve from the user
   * artifacts bucket and are not part of the thread's run artifacts.
   */
  readonly artifact?: {
    readonly file: ChatThreadArtifactFile;
    readonly runId: string;
  };
};

type ImageArtifactNavigation = {
  readonly next?: ImageArtifactNavigationItem;
  readonly previous?: ImageArtifactNavigationItem;
};

/**
 * Minimal shape of a chat message needed to scope image navigation. Images in a
 * message come from two sources: `attachFiles` (files the user attached) and the
 * rendered body `blocks` (image previews parsed from message content, e.g.
 * agent-generated images). Structurally satisfied by `EnrichedChatMessage`.
 */
type MessageImageSource = {
  readonly attachFiles?: readonly {
    readonly url: string;
    readonly filename: string;
    readonly contentType: string;
  }[];
  readonly blocks?: readonly BodyRenderBlock[];
};

type MessageImageGroup = {
  readonly messages: readonly MessageImageSource[];
};

function isImageDescriptor(descriptor: {
  contentType: string;
  filename: string;
  url: string;
}): boolean {
  return (
    classifyChatAttachment({
      contentType: descriptor.contentType,
      filename: descriptor.filename,
      url: descriptor.url,
    }) === "image"
  );
}

type MessageImage = {
  readonly url: string;
  readonly filename: string;
};

type ArtifactImageMetadata = {
  readonly file: ChatThreadArtifactFile;
  readonly runId: string;
};

// Matches markdown images `![alt](url)` and links `[label](url)`, capturing the
// optional image marker, label/alt text, and url while allowing escaped label
// characters. Agent-generated images can render as markdown image lines or
// media links rather than dedicated preview blocks.
const MARKDOWN_IMAGE_OR_LINK_PATTERN = /(!?)\[((?:\\.|[^\]\\])*)\]\(([^)]+)\)/g;

function unescapeMarkdownText(value: string): string {
  return value.replace(/\\([\]\\])/g, "$1");
}

function filenameFromImageUrl(url: string): string {
  const path = url.split("?")[0].split("#")[0];
  return path.split("/").pop() || "image";
}

function isMarkdownImageLinkUrl(url: string): boolean {
  return (
    /^https?:\/\//i.test(url) &&
    /\.(png|jpe?g|gif|webp|svg|bmp|avif)(?:\?|#|$)/i.test(url)
  );
}

function filenameFromMarkdownLink(label: string, url: string): string {
  const text = unescapeMarkdownText(label).trim();
  if (text.length > 0 && !/^https?:\/\//i.test(text)) {
    return text;
  }
  return filenameFromImageUrl(url);
}

/** Ordered, de-duplicated images (url + filename) shown in a single message. */
function messageImages(message: MessageImageSource): MessageImage[] {
  const images: MessageImage[] = [];
  const seen = new Set<string>();
  const add = (url: string, filename: string): void => {
    if (!seen.has(url)) {
      seen.add(url);
      images.push({ url, filename });
    }
  };

  for (const file of message.attachFiles ?? []) {
    if (isImageDescriptor(file)) {
      add(file.url, file.filename);
    }
  }
  for (const block of message.blocks ?? []) {
    if (block.type === "artifact") {
      if (block.signals.kind === "image") {
        add(block.signals.url, block.signals.filename);
      }
      continue;
    }
    if (block.type === "markdown") {
      for (const match of block.content.matchAll(
        MARKDOWN_IMAGE_OR_LINK_PATTERN,
      )) {
        const marker = match[1];
        const label = match[2] ?? "";
        const url = match[3];
        if (!url) {
          continue;
        }
        if (marker === "!") {
          const alt = unescapeMarkdownText(label);
          add(url, alt || filenameFromImageUrl(url));
          continue;
        }
        if (isMarkdownImageLinkUrl(url)) {
          add(url, filenameFromMarkdownLink(label, url));
        }
      }
    }
  }
  return images;
}

function messageHasImageUrl(
  message: MessageImageSource,
  currentUrl: string,
): boolean {
  return messageImages(message).some((image) => {
    return artifactPreviewUrlsMatch(image.url, currentUrl);
  });
}

function scopedMessageImages(
  messages: readonly MessageImageSource[],
): MessageImage[] {
  const images: MessageImage[] = [];
  for (const message of messages) {
    for (const image of messageImages(message)) {
      if (
        images.some((candidate) => {
          return artifactPreviewUrlsMatch(candidate.url, image.url);
        })
      ) {
        continue;
      }
      images.push(image);
    }
  }
  return images;
}

function imageScopes(groups: readonly MessageImageGroup[]): MessageImage[][] {
  return groups.flatMap((group) => {
    const images = scopedMessageImages(group.messages);
    return images.length > 0 ? [images] : [];
  });
}

export function equalMessageImageGroups(
  previous: readonly MessageImageGroup[],
  next: readonly MessageImageGroup[],
): boolean {
  if (previous === next) {
    return true;
  }
  const previousScopes = imageScopes(previous);
  const nextScopes = imageScopes(next);
  return (
    previousScopes.length === nextScopes.length &&
    previousScopes.every((scope, scopeIndex) => {
      const nextScope = nextScopes[scopeIndex];
      return (
        nextScope !== undefined &&
        scope.length === nextScope.length &&
        scope.every((image, imageIndex) => {
          const nextImage = nextScope[imageIndex];
          return (
            nextImage !== undefined &&
            image.url === nextImage.url &&
            image.filename === nextImage.filename
          );
        })
      );
    })
  );
}

function artifactMetadataForUrl(
  artifacts: readonly ArtifactImageMetadata[],
  url: string,
): ArtifactImageMetadata | undefined {
  return artifacts.find((artifact) => {
    return artifactPreviewUrlsMatch(artifact.file.url, url);
  });
}

/**
 * Navigate image previews within the displayed image scope for `currentUrl`.
 * The rendered chat message group is the scope boundary, so agent and human
 * messages use the same rule: extract the images visible in the group that
 * contains the current image. Run artifacts only enrich metadata when
 * available; generated/hosted artifacts that live in the run but are not shown
 * in rendered messages are excluded.
 */
export function currentMessageImageArtifactNavigation(
  runs: readonly ChatThreadArtifactRun[],
  groups: readonly MessageImageGroup[],
  currentUrl: string,
): ImageArtifactNavigation {
  const group = groups.find((candidateGroup) => {
    return candidateGroup.messages.some((message) => {
      return messageHasImageUrl(message, currentUrl);
    });
  });

  if (!group) {
    return {};
  }

  const artifacts: ArtifactImageMetadata[] = [];
  for (const run of runs) {
    for (const file of run.files) {
      artifacts.push({ file, runId: run.runId });
    }
  }

  const images: ImageArtifactNavigationItem[] = scopedMessageImages(
    group.messages,
  ).map((image) => {
    const artifact = artifactMetadataForUrl(artifacts, image.url);
    if (artifact) {
      return {
        url: image.url,
        filename: artifact.file.filename,
        artifact,
      };
    }
    return { url: image.url, filename: image.filename };
  });
  const currentIndex = images.findIndex((item) => {
    return artifactPreviewUrlsMatch(item.url, currentUrl);
  });

  if (currentIndex === -1) {
    return {};
  }

  return {
    previous: currentIndex > 0 ? images[currentIndex - 1] : undefined,
    next:
      currentIndex < images.length - 1 ? images[currentIndex + 1] : undefined,
  };
}

/** Whether an editable control (where arrow keys move a cursor/selection) is focused. */
function isEditableElementFocused(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) {
    return false;
  }
  return (
    active.tagName === "INPUT" ||
    active.tagName === "TEXTAREA" ||
    active.tagName === "SELECT" ||
    active.isContentEditable
  );
}

/**
 * Whether an arrow-key event should be ignored for image navigation.
 *
 * Modifier/hotkey combinations are always ignored. The focus guard — skip
 * navigation while an editable control (input/textarea/select/contenteditable)
 * is focused, so arrow keys keep moving the caret — is only applied when
 * `considerFocus` is true. Callers pass `considerFocus: false` for immersive
 * surfaces (the lightbox modal and the fullscreen sidebar) where arrow keys
 * should always navigate regardless of focus.
 */
export function shouldIgnoreImageArtifactNavigationKey(
  event: KeyboardEvent,
  options: { considerFocus: boolean } = { considerFocus: true },
): boolean {
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return true;
  }

  if (!options.considerFocus) {
    return false;
  }

  return isEditableElementFocused();
}
