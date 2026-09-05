import { cn } from "@okouai/ui";
import type { Element, Root } from "hast";
import { useTranslation } from "react-i18next";
import type { EnrichedChatEvent } from "../../signals/chat-page/chat-event.ts";
import { CHAT_THREAD_RESPONSE_LINE_CLASS } from "./chat-message-surface.tsx";

const blockTags: ReadonlySet<string> = new Set([
  "address",
  "blockquote",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "ol",
  "p",
  "pre",
  "table",
  "tr",
  "ul",
  "br",
]);

function previewText(event: EnrichedChatEvent, fallback: string): string {
  if (event.tree === undefined) {
    return event.content?.trim().replace(/\s+/g, " ") || fallback;
  }
  const parts: string[] = [];
  const visit = (node: Root | Element): void => {
    if (node.type === "element") {
      const card = node.data?.card;
      if (card !== undefined) {
        parts.push(card.kind === "artifact" ? card.signals.filename : fallback);
        return;
      }
      if (node.tagName === "img") {
        const alt = node.properties.alt;
        parts.push(typeof alt === "string" && alt.trim() ? alt : fallback);
      }
      if (blockTags.has(node.tagName)) {
        parts.push(" ");
      }
    }
    for (const child of node.children) {
      if (child.type === "text" || child.type === "raw") {
        parts.push(child.value);
      } else if (child.type === "element") {
        visit(child);
      }
    }
    if (node.type === "element" && blockTags.has(node.tagName)) {
      parts.push(" ");
    }
  };
  visit(event.tree);
  return parts.join("").trim().replace(/\s+/g, " ") || fallback;
}

export function RunWorkMessagePreview({ event }: { event: EnrichedChatEvent }) {
  const { t } = useTranslation();
  const text = previewText(
    event,
    t(($) => {
      return $.chat.composer.message;
    }),
  );
  return (
    <div
      data-chat-run-work-preview
      className={cn(
        "flex h-5 min-w-0 max-w-full items-center gap-2 text-[13px] leading-5 text-muted-foreground/60",
        CHAT_THREAD_RESPONSE_LINE_CLASS,
      )}
    >
      <span aria-hidden className="shrink-0">
        •
      </span>
      <span className="min-w-0 flex-1 truncate whitespace-nowrap">{text}</span>
    </div>
  );
}
