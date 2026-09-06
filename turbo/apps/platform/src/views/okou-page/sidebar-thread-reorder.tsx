import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { GripVertical, ArrowUp, ArrowDown } from "lucide-react";
import { Button, DropdownMenuItem } from "@okouai/ui";
import {
  pinnedThreadReorderEnabled$,
  stepPinnedThread$,
  type PinnedThreadDragSignals,
} from "../../signals/chat-page/chat-thread-pin-order.ts";
import type { SidebarChatThreadItemSignals } from "../../signals/chat-page/sidebar-chat-thread-item.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { CHAT_THREAD_VIRTUAL_ROW_HEIGHT } from "../../signals/okou-page/sidebar-state.ts";
import { detach, Reason } from "../../signals/utils.ts";
import "./sidebar-thread-reorder.css";

export function PinnedThreadDropZone({
  signals,
  className,
  children,
}: {
  signals: PinnedThreadDragSignals;
  className: string;
  children: ReactNode;
}) {
  const enabled = useGet(pinnedThreadReorderEnabled$);
  const mount = useSet(signals.mountDropZone$);
  const drop = useSet(signals.dropPointer$);
  const signal = useGet(pageSignal$);
  return (
    <div
      ref={enabled ? mount : undefined}
      data-testid="pinned-thread-drop-zone"
      className={className}
      onDrop={() => {
        detach(drop(signal), Reason.DomCallback);
      }}
    >
      {children}
    </div>
  );
}

export function ThreadPinMoveMenuItems({
  signals,
}: {
  signals: SidebarChatThreadItemSignals;
}) {
  const { t } = useTranslation();
  const enabled = useGet(pinnedThreadReorderEnabled$);
  const pinned = useGet(signals.pinned$);
  const move = useSet(stepPinnedThread$);
  const signal = useGet(pageSignal$);
  if (!enabled || !pinned) {
    return null;
  }
  return (
    <>
      <DropdownMenuItem
        onSelect={() => {
          return detach(move(signals.threadId, -1, signal), Reason.DomCallback);
        }}
      >
        <ArrowUp />
        {t(($) => {
          return $.chat.sidebar.movePinUp;
        })}
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => {
          return detach(move(signals.threadId, 1, signal), Reason.DomCallback);
        }}
      >
        <ArrowDown />
        {t(($) => {
          return $.chat.sidebar.movePinDown;
        })}
      </DropdownMenuItem>
    </>
  );
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
  const cancelKeyboard = useSet(dragSignals.cancelKeyboard$);
  const drop = useSet(dragSignals.drop$);
  const step = useSet(dragSignals.step$);
  const signal = useGet(pageSignal$);
  const picked = drag?.threadId === signals.threadId;
  return (
    <Button
      className="okou-thread-drag-handle pointer-events-auto absolute left-1 top-1 z-10 cursor-grab active:cursor-grabbing"
      variant="quiet"
      size="icon-2xs"
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
      onKeyDown={(event) => {
        if (event.key === " " || event.key === "Enter") {
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
          event.preventDefault();
          event.stopPropagation();
          step(event.key === "ArrowUp" ? -1 : 1);
        } else if (event.key === "Escape" && cancelKeyboard(signals.threadId)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onBlur={() => {
        cancelKeyboard(signals.threadId);
      }}
    >
      <GripVertical size={16} />
    </Button>
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
  const mountRow = useSet(dragSignals.mountRow$);
  const reorderable = enabled && pinned;
  return (
    <div
      ref={reorderable ? mountRow : undefined}
      className="group relative grid grid-cols-[minmax(0,1fr)_auto] okou-thread-reorder-row"
      data-thread-id={signals.threadId}
      data-reorderable={reorderable || undefined}
      data-dragging={
        drag?.threadId === signals.threadId
          ? drag.keyboard
            ? "keyboard"
            : "pointer"
          : undefined
      }
    >
      {children}
      {reorderable && (
        <div className="pointer-events-none absolute left-0 top-0 h-8 w-8 overflow-hidden">
          <ThreadDragHandle signals={signals} dragSignals={dragSignals} />
        </div>
      )}
    </div>
  );
}

export function PinnedThreadDropPlaceholder({
  signals,
}: {
  signals: PinnedThreadDragSignals;
}) {
  const placement = useGet(signals.placement$);
  if (!placement) {
    return null;
  }
  return (
    <div
      aria-hidden="true"
      data-testid="pinned-thread-drop-placeholder"
      className="pointer-events-none absolute left-0 top-0 h-8 w-full rounded-lg border border-dashed border-border bg-muted/30"
      style={{
        transform: `translateY(${placement.destinationIndex * CHAT_THREAD_VIRTUAL_ROW_HEIGHT}px)`,
      }}
    />
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
  const enabled = useGet(pinnedThreadReorderEnabled$);
  const announcement = useGet(signals.announcement$);
  const mount = useSet(signals.mount$);
  if (!enabled) {
    return null;
  }
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
