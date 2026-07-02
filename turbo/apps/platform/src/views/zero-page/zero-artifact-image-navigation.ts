import type {
  ChatThreadArtifactFile,
  ChatThreadArtifactRun,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  type BodyRenderBlock,
  classifyChatAttachment,
} from "../../signals/chat-page/parse-body-blocks.ts";

export type ImageArtifactNavigationItem = {
  readonly file: ChatThreadArtifactFile;
  readonly runId: string;
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

// Matches a markdown image `![alt](url)`, allowing escaped characters in the
// alt text. Agent-generated images render as markdown image lines rather than
// dedicated preview blocks (see renderExtractedPreviewLine).
const MARKDOWN_IMAGE_PATTERN = /!\[(?:\\.|[^\]\\])*\]\(([^)]+)\)/g;

/** Ordered, de-duplicated image URLs shown in a single message. */
function messageImageUrls(message: MessageImageSource): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const add = (url: string): void => {
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  };

  for (const file of message.attachFiles ?? []) {
    if (isImageDescriptor(file)) {
      add(file.url);
    }
  }
  for (const block of message.blocks ?? []) {
    if (block.type === "preview") {
      if (block.preview.kind === "image") {
        add(block.preview.url);
      }
      continue;
    }
    if (block.type === "markdown") {
      for (const match of block.content.matchAll(MARKDOWN_IMAGE_PATTERN)) {
        add(match[1]);
      }
    }
  }
  return urls;
}

/**
 * Navigate image previews strictly within the images attached to the same chat
 * message as `currentUrl`. Generated/hosted artifacts that live in the run but
 * were not attached to the message are excluded. File metadata is sourced from
 * the run artifacts so the lightbox keeps download/share/sync capabilities.
 */
export function currentMessageImageArtifactNavigation(
  runs: readonly ChatThreadArtifactRun[],
  messages: readonly MessageImageSource[],
  currentUrl: string,
): ImageArtifactNavigation {
  const message = messages.find((candidate) => {
    return messageImageUrls(candidate).includes(currentUrl);
  });

  if (!message) {
    return {};
  }

  const artifactByUrl = new Map<string, ImageArtifactNavigationItem>();
  for (const run of runs) {
    for (const file of run.files) {
      if (!artifactByUrl.has(file.url)) {
        artifactByUrl.set(file.url, { file, runId: run.runId });
      }
    }
  }

  const images = messageImageUrls(message)
    .map((url) => {
      return artifactByUrl.get(url);
    })
    .filter((item): item is ImageArtifactNavigationItem => {
      return item !== undefined;
    });
  const currentIndex = images.findIndex((item) => {
    return item.file.url === currentUrl;
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
