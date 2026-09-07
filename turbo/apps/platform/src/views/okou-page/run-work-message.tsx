import { Button, cn } from "@okouai/ui";
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
      className={cn(
        "min-w-0 max-w-full text-[13px] leading-5",
        expanded &&
          "-mx-2 grid grid-cols-[5px_minmax(0,1fr)_28px] items-start gap-x-2 px-2 py-1",
      )}
    >
      <Button
        type="button"
        variant="quiet"
        size={expanded ? "icon-xs" : "sm"}
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
        className={cn(
          "text-[13px]",
          expanded
            ? "col-start-3 row-start-1 -mt-0.5 text-muted-foreground/70"
            : "group -mx-2 h-auto min-h-8 w-[calc(100%+1rem)] justify-start px-2 text-left font-normal text-muted-foreground/60 hover:text-muted-foreground",
        )}
      >
        {expanded ? (
          <ChevronUp aria-hidden />
        ) : (
          <>
            <span aria-hidden className="shrink-0">
              •
            </span>
            <span className="min-w-0 flex-1 truncate whitespace-nowrap">
              {text}
            </span>
            <ChevronRight
              aria-hidden
              className="shrink-0 text-muted-foreground/50"
            />
          </>
        )}
      </Button>
      <div
        id={contentId}
        hidden={!expanded}
        className="col-start-2 row-start-1 min-w-0 text-foreground"
      >
        {expanded ? children : null}
      </div>
      {expanded ? (
        <span
          aria-hidden
          className="col-start-1 row-start-1 mt-2.5 text-muted-foreground/60"
        >
          •
        </span>
      ) : null}
    </div>
  );
}
