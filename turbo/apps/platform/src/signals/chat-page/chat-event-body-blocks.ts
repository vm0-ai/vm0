import {
  chatEventCompatibilityRole,
  isChatEventContentTextType,
} from "@vm0/api-contracts/contracts/chat-events";
import { escapeHtmlTags } from "../../lib/markdown/pipeline.ts";
import { messageDocumentToDisplayText } from "../zero-page/user-message-document-codec.ts";
import {
  isFollowupsEvent,
  isGoalMarkerEvent,
  isGoalQueueEvent,
  isInterruptControlEvent,
  isQueueMarkerEvent,
  isRecallControlEvent,
} from "./chat-event-state.ts";
import {
  eventBodyPlan,
  parseBodyBlocks,
  type CardDescriptorBlock,
  type ParsedBodyBlock,
} from "./parse-body-blocks.ts";
import type { ChatEvent } from "./chat-event-types.ts";

function chatEventBodyContent(event: ChatEvent): string {
  if (chatEventCompatibilityRole(event.eventType) === "assistant") {
    return isChatEventContentTextType(event.eventType)
      ? (event.content ?? "")
      : "";
  }
  if (
    event.eventType === "input.prompt" ||
    event.eventType === "input.automation" ||
    event.eventType === "input.goal" ||
    event.eventType === "input.rejected"
  ) {
    if (event.eventType === "input.automation" && !event.userMessage) {
      return "";
    }
    const content = messageDocumentToDisplayText(event.userMessage);
    if (content === null) {
      throw new Error(`${event.eventType} is missing a valid userMessage`);
    }
    return content.trim();
  }
  return event.content?.trim() ?? "";
}

export function parseChatEventBodyBlocks(
  event: ChatEvent,
  threadId: string,
): ParsedBodyBlock[] {
  const content = chatEventBodyContent(event);
  return parseBodyBlocks(content, {
    previews: chatEventCompatibilityRole(event.eventType) === "assistant",
    browserThreadId: threadId,
  }).blocks;
}

function skipsEventBodyRendering(event: ChatEvent): boolean {
  return (
    isInterruptControlEvent(event) ||
    isRecallControlEvent(event) ||
    isQueueMarkerEvent(event) ||
    isGoalQueueEvent(event) ||
    isFollowupsEvent(event) ||
    isGoalMarkerEvent(event)
  );
}

/** Whether the event carries a body the transcript renders as markdown. */
export function hasChatEventBodyContent(event: ChatEvent): boolean {
  return chatEventTreeContent(event) !== null;
}

/**
 * The raw body an event's markdown tree is parsed from, or null when the event
 * renders no body. Cheap relative to planning: the visibility-driven ensure
 * pass runs on every scroll capture, so the unchanged-content skip has to cost
 * a lookup, not a card scan.
 */
export function chatEventTreeContent(event: ChatEvent): string | null {
  if (skipsEventBodyRendering(event)) {
    return null;
  }
  const content = chatEventBodyContent(event);
  return /\S/.test(content) ? content : null;
}

interface ChatEventTreePlan {
  /** The raw body the plan was made from; a cache key for the parsed tree. */
  readonly content: string;
  readonly treeSource: string;
  readonly descriptors: readonly CardDescriptorBlock[];
}

/**
 * Plans the single markdown document an event renders as. Assistant bodies go
 * through card recognition; user bodies are written in a composer, so their
 * newlines are literal and any HTML they contain is text.
 */
export function chatEventTreePlan(
  event: ChatEvent,
  threadId: string,
): ChatEventTreePlan | null {
  const content = chatEventTreeContent(event);
  if (content === null) {
    return null;
  }
  if (chatEventCompatibilityRole(event.eventType) === "assistant") {
    const plan = eventBodyPlan(content, {
      previews: true,
      browserThreadId: threadId,
    });
    return {
      content,
      treeSource: plan.treeSource,
      descriptors: plan.descriptors,
    };
  }
  return {
    content,
    treeSource: escapeHtmlTags(content.replace(/\n/g, "  \n")),
    descriptors: [],
  };
}
