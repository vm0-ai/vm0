import type { DragEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { GripVertical, ArrowUp, ArrowDown } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@okouai/ui";
import {
  pinnedThreadReorderEnabled$,
  stepPinnedThread$,
  type PinnedThreadDragSignals,
} from "../../signals/chat-page/chat-thread-pin-order.ts";
import type { SidebarChatThreadItemSignals } from "../../signals/chat-page/sidebar-chat-thread-item.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import "./sidebar-thread-reorder.css";

const THREAD_DRAG_TYPE = "application/x-okou-pinned-thread";

function prepareThreadPointerDrag(
  event: DragEvent<HTMLButtonElement>,
  threadId: string,
) {
  const row = event.currentTarget.closest(".okou-thread-reorder-row");
  if (!(row instanceof HTMLElement)) {
    return null;
  }
  event.dataTransfer.setData(THREAD_DRAG_TYPE, threadId);
  event.dataTransfer.effectAllowed = "move";
  const image = row.querySelector(".okou-thread-drag-image");
  if (image instanceof HTMLElement) {
    event.dataTransfer.setDragImage(image, 0, 0);
  }
  return {
    x: event.clientX,
    y: event.clientY,
    width: row.getBoundingClientRect().width,
  };
}

function ThreadDragHandle({
  signals,
  dragSignals,
}: {
  signals: SidebarChatThreadItemSignals;
  dragSignals: PinnedThreadDragSignals;
}) {
  const { t } = useTranslation();
  const title =
    useGet(signals.title$) ??
    t(($) => {
      return $.chat.newChat;
    });
  const drag = useGet(dragSignals.drag$);
  const start = useSet(dragSignals.start$);
  const cancel = useSet(dragSignals.cancel$);
  const drop = useSet(dragSignals.drop$);
  const step = useSet(dragSignals.step$);
  const move = useSet(stepPinnedThread$);
  const signal = useGet(pageSignal$);
  const picked = drag?.threadId === signals.threadId;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        asChild
        // Open on click, leaving pointer presses available for native dragging.
        onPointerDown={(event) => {
          event.preventBaseUIHandler();
        }}
        onMouseDown={(event) => {
          event.preventBaseUIHandler();
        }}
        onKeyDown={(event) => {
          if (event.key === " " || event.key === "Enter") {
            event.preventBaseUIHandler();
            event.preventDefault();
            event.stopPropagation();
            if (picked) {
              detach(drop(signal), Reason.DomCallback);
            } else {
              start(signals.threadId, null);
            }
          } else if (
            picked &&
            (event.key === "ArrowUp" || event.key === "ArrowDown")
          ) {
            event.preventBaseUIHandler();
            event.preventDefault();
            event.stopPropagation();
            step(event.key === "ArrowUp" ? -1 : 1);
          } else if (picked && event.key === "Escape") {
            event.preventBaseUIHandler();
            event.preventDefault();
            event.stopPropagation();
            cancel();
          }
        }}
      >
        <Button
          className="okou-thread-drag-handle pointer-events-auto absolute left-1 top-1 z-10 cursor-grab active:cursor-grabbing"
          variant="quiet"
          size="icon-2xs"
          draggable
          aria-label={t(
            ($) => {
              return $.chat.sidebar.reorderThread;
            },
            { title },
          )}
          aria-pressed={picked}
          title={t(($) => {
            return $.chat.sidebar.reorderInstructions;
          })}
          onDragStart={(event) => {
            const pointer = prepareThreadPointerDrag(event, signals.threadId);
            if (pointer) {
              start(signals.threadId, pointer);
            }
          }}
          onDragEnd={() => {
            return cancel();
          }}
          onBlur={() => {
            if (picked && drag.keyboard) {
              cancel();
            }
          }}
        >
          <GripVertical size={16} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem
          onSelect={() => {
            return detach(
              move(signals.threadId, -1, signal),
              Reason.DomCallback,
            );
          }}
        >
          <ArrowUp />
          {t(($) => {
            return $.chat.sidebar.movePinUp;
          })}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            return detach(
              move(signals.threadId, 1, signal),
              Reason.DomCallback,
            );
          }}
        >
          <ArrowDown />
          {t(($) => {
            return $.chat.sidebar.movePinDown;
          })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PinnedThreadRow({
  signals,
  dragSignals,
  children,
}: {
  signals: SidebarChatThreadItemSignals;
  dragSignals: PinnedThreadDragSignals;
  children: ReactNode;
}) {
  const enabled = useGet(pinnedThreadReorderEnabled$);
  const pinned = useGet(signals.pinned$);
  const drag = useGet(dragSignals.drag$);
  const target = useSet(dragSignals.target$);
  const drop = useSet(dragSignals.drop$);
  const signal = useGet(pageSignal$);
  const reorderable = enabled && pinned;
  const targetSide =
    drag?.targetId === signals.threadId && drag.threadId !== signals.threadId
      ? drag.side
      : undefined;
  return (
    <div
      className="group relative okou-thread-reorder-row"
      data-reorderable={reorderable || undefined}
      data-dragging={
        drag?.threadId === signals.threadId
          ? drag.keyboard
            ? "keyboard"
            : "pointer"
          : undefined
      }
      data-drop-side={targetSide}
      onDragOver={(event) => {
        if (
          !reorderable ||
          !drag ||
          !event.dataTransfer.types.includes(THREAD_DRAG_TYPE)
        ) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const rect = event.currentTarget.getBoundingClientRect();
        target(
          signals.threadId,
          event.clientY < rect.top + rect.height / 2 ? "before" : "after",
        );
      }}
      onDrop={(event) => {
        if (
          reorderable &&
          drag &&
          event.dataTransfer.types.includes(THREAD_DRAG_TYPE)
        ) {
          event.preventDefault();
          detach(drop(signal), Reason.DomCallback);
        }
      }}
    >
      {children}
      {reorderable && (
        <>
          <span
            aria-hidden="true"
            className="okou-thread-drag-image pointer-events-none absolute left-0 top-0 h-px w-px opacity-0"
          />
          <div className="pointer-events-none absolute left-0 top-0 h-8 w-8 overflow-hidden">
            <ThreadDragHandle signals={signals} dragSignals={dragSignals} />
          </div>
        </>
      )}
    </div>
  );
}

export function PinnedThreadDragPreview({
  signals,
}: {
  signals: PinnedThreadDragSignals;
}) {
  const { t } = useTranslation();
  const preview = useGet(signals.preview$);
  if (!preview) {
    return null;
  }
  return createPortal(
    <div
      aria-hidden="true"
      data-testid="pinned-thread-drag-preview"
      className="pointer-events-none fixed left-0 top-0 z-50 flex h-8 max-w-64 items-center gap-2 rounded-lg border border-border bg-popover px-2 text-sm text-popover-foreground shadow-sm"
      style={{
        width: preview.width,
        transform: `translate(${preview.x + 16}px, ${preview.y + 16}px)`,
      }}
    >
      <GripVertical size={16} className="shrink-0 text-muted-foreground" />
      <span className="truncate">
        {preview.title ??
          t(($) => {
            return $.chat.newChat;
          })}
      </span>
    </div>,
    document.body,
  );
}

export function PinnedThreadDragAnnouncement({
  signals,
}: {
  signals: PinnedThreadDragSignals;
}) {
  const { t } = useTranslation();
  const announcement = useGet(signals.announcement$);
  const mount = useSet(signals.mount$);
  return (
    <span ref={mount} className="sr-only" aria-live="polite" aria-atomic="true">
      {announcement
        ? announcement.side === "before"
          ? t(
              ($) => {
                return $.chat.sidebar.pinDropBefore;
              },
              { title: announcement.title },
            )
          : t(
              ($) => {
                return $.chat.sidebar.pinDropAfter;
              },
              { title: announcement.title },
            )
        : ""}
    </span>
  );
}
