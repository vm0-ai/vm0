import type { CSSProperties } from "react";
import { IconCopy, IconMessageCircle } from "@tabler/icons-react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  getShortcutParts,
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@vm0/ui";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import type {
  ChatThreadFeedbackSelection,
  ChatThreadFeedbackSignals,
} from "../../signals/chat-page/chat-thread-feedback.ts";

function anchorStyle(selection: ChatThreadFeedbackSelection): CSSProperties {
  return {
    position: "fixed",
    top: selection.rect.top,
    left: selection.rect.left,
    width: selection.rect.width,
    height: selection.rect.height,
    pointerEvents: "none",
  };
}

function ShortcutHint({ shortcut }: { readonly shortcut: string }) {
  return (
    <span aria-hidden="true" className="ml-0.5 inline-flex items-center gap-1">
      {getShortcutParts(shortcut).map((part) => {
        return (
          <kbd
            key={part}
            className='inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-background px-1 text-[10px] font-medium leading-none text-muted-foreground shadow-[inset_0_-1px_0_hsl(var(--border)),0_0_0_1px_hsl(var(--border))] font-["-apple-system",BlinkMacSystemFont,"Segoe_UI",system-ui,sans-serif]'
          >
            {part.length === 1 ? part.toUpperCase() : part}
          </kbd>
        );
      })}
    </span>
  );
}

function FeedbackToolbar({
  onCopy,
  onProvideFeedback,
}: {
  onCopy: () => void;
  onProvideFeedback: () => void;
}) {
  const { t } = useTranslation();
  return (
    <PopoverContent
      side="top"
      align="center"
      sideOffset={8}
      onOpenAutoFocus={(event) => {
        return event.preventDefault();
      }}
      onCloseAutoFocus={(event) => {
        return event.preventDefault();
      }}
      className="w-auto rounded-xl border-[0.7px] border-[hsl(var(--gray-400))] bg-[hsl(var(--card)/0.85)] p-1 text-foreground shadow-lg"
    >
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={onCopy}
          aria-keyshortcuts="c"
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <IconCopy size={14} stroke={2} />
          {t(($) => {
            return $.chat.actions.copy;
          })}
          <ShortcutHint shortcut="c" />
        </button>
        <div className="h-4 w-px bg-border" />
        <button
          type="button"
          onClick={onProvideFeedback}
          aria-keyshortcuts="f"
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <IconMessageCircle size={14} stroke={2} />
          {t(($) => {
            return $.chat.feedback.provide;
          })}
          <ShortcutHint shortcut="f" />
        </button>
      </div>
    </PopoverContent>
  );
}

// Mounts the selection listeners and the floating Copy / Provide feedback
// toolbar anchored to the highlighted passage. Picking "Provide feedback"
// drops the quoted passage straight into the composer (see ComposerFeedbackRows
// in zero-chat-composer.tsx) — there is no separate feedback panel.
export function ChatFeedbackSelection({
  feedback,
}: {
  readonly feedback: ChatThreadFeedbackSignals;
}) {
  const selection = useGet(feedback.selection$);
  const rootSignal = useGet(rootSignal$);
  const setFeedbackSelectionListenersRef = useSet(feedback.setListenersRef$);
  const setFeedbackSelectionToolbarRef = useSet(feedback.setToolbarRef$);
  const startFeedback = useSet(feedback.start$);
  const closeSelectionToolbar = useSet(feedback.close$);
  const copy = useSet(feedback.copy$);

  return (
    <>
      <span ref={setFeedbackSelectionListenersRef} hidden />
      {selection ? (
        <Popover
          open
          onOpenChange={(next) => {
            if (!next) {
              closeSelectionToolbar();
            }
          }}
        >
          <PopoverAnchor asChild>
            <div style={anchorStyle(selection)} aria-hidden />
          </PopoverAnchor>
          <span ref={setFeedbackSelectionToolbarRef} hidden />
          <FeedbackToolbar
            onCopy={() => {
              return detach(copy(rootSignal), Reason.DomCallback);
            }}
            onProvideFeedback={startFeedback}
          />
        </Popover>
      ) : null}
    </>
  );
}
