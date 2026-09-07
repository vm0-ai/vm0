import { Button } from "@okouai/ui";
import type { Element, Root } from "hast";
import { ChevronRight, ChevronUp } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { EnrichedChatEvent } from "../../signals/chat-page/chat-event.ts";

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
      if (card !== undefined && card.kind !== "artifact") {
        parts.push(fallback);
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

export function RunWorkMessage({
  event,
  expanded,
  onToggle,
  children,
}: {
  event: EnrichedChatEvent;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const text = previewText(
    event,
    t(($) => {
      return $.chat.composer.message;
    }),
  );
  const contentId = `chat-run-work-message-${event.id}`;
  return (
    <div
      data-chat-run-work-message
      data-chat-run-work-message-expanded={expanded || undefined}
      data-chat-run-work-preview={expanded ? undefined : ""}
      className="group/history-message flex min-h-7 w-fit min-w-0 max-w-[92%] items-start text-[13px] leading-5 text-muted-foreground transition-colors hover:text-foreground"
    >
      <div
        id={contentId}
        className={
          expanded ? "min-w-0 flex-[0_1_auto]" : "min-w-0 flex-[0_1_auto] py-1"
        }
      >
        {expanded ? (
          children
        ) : (
          <span className="block min-w-0 truncate whitespace-nowrap">
            {text}
          </span>
        )}
      </div>
      <Button
        type="button"
        variant="quiet"
        size="icon-xs"
        aria-expanded={expanded}
        aria-controls={contentId}
        aria-label={
          expanded
            ? t(
                ($) => {
                  return $.chat.run.collapseHistoryMessage;
                },
                { message: text },
              )
            : text
        }
        onClick={onToggle}
        className="shrink-0 text-muted-foreground/70 [&_svg]:size-3.5"
      >
        {expanded ? <ChevronUp aria-hidden /> : <ChevronRight aria-hidden />}
      </Button>
    </div>
  );
}
