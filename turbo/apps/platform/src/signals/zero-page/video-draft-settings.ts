import type {
  GenerationTemplateRequest,
  UserMessageDocument,
  UserMessageInputDocument,
  VideoGenerationOptions,
} from "@vm0/api-contracts/contracts/chat-threads";
import { revokedChatEventIds } from "@vm0/api-contracts/contracts/chat-events";
import { parseAvatarTemplateStylePresetId } from "@vm0/core/avatar-template";
import type { ChatEvent } from "../chat-page/chat-event-types.ts";
import type { EditorDocumentSnapshot } from "./user-message-document-codec.ts";

const VIDEO_DRAFT_PATTERN = /(?:\bvideos?\b|视频|影片|短片)/iu;

/** Conservative lexical hint used only to reveal the video settings control. */
export function draftMentionsVideo(input: string): boolean {
  return VIDEO_DRAFT_PATTERN.test(input);
}

export function videoSettingsFromMessage(
  document: UserMessageDocument | UserMessageInputDocument | null | undefined,
): VideoGenerationOptions | undefined {
  return document?.videoOptions;
}

/** Replace the draft-owned metadata while preserving every visible part. */
export function withVideoSettingsMetadata(
  document: UserMessageInputDocument,
  videoOptions: VideoGenerationOptions | undefined,
): UserMessageInputDocument {
  return {
    version: 1,
    parts: document.parts,
    ...(videoOptions ? { videoOptions } : {}),
  };
}

/** Latest authored model acts as the lightweight thread-level fallback. */
export function latestVideoSettingsFromChatEvents(
  events: readonly ChatEvent[],
): VideoGenerationOptions | undefined {
  const revoked = revokedChatEventIds(events);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event?.eventType !== "input.prompt" ||
      revoked.has(event.id) ||
      event.userMessage === null
    ) {
      continue;
    }
    const options = videoSettingsFromMessage(event.userMessage);
    if (options?.model !== undefined) {
      return { model: options.model };
    }
  }
  return undefined;
}

export function messageVideoTemplateContext(
  editorDocument: EditorDocumentSnapshot,
  selectedTemplate: GenerationTemplateRequest | undefined,
): {
  readonly hasTextToVideoTemplate: boolean;
  readonly hasAvatarTemplate: boolean;
} {
  const document = editorDocument.toMessageDocument();
  let hasTextToVideoTemplate = false;
  let hasAvatarTemplate = false;
  const register = (template: GenerationTemplateRequest | undefined): void => {
    if (template?.type !== "video") {
      return;
    }
    if (
      parseAvatarTemplateStylePresetId(template.selection.stylePresetId) ===
      undefined
    ) {
      hasTextToVideoTemplate = true;
    } else {
      hasAvatarTemplate = true;
    }
  };
  register(selectedTemplate);
  for (const part of document?.parts ?? []) {
    if (part.type !== "template") {
      continue;
    }
    register(part.template);
  }
  return { hasTextToVideoTemplate, hasAvatarTemplate };
}
