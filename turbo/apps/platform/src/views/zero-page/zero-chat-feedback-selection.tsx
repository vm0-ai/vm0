import type { CSSProperties } from "react";
import { IconCheck, IconCopy, IconMessageCircle } from "@tabler/icons-react";
import { useGet, useSet } from "ccstate-react";
import {
  getShortcutParts,
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@vm0/ui";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  closeFeedbackSelectionToolbar$,
  copyFeedbackSelection$,
  feedbackCopiedValue$,
  feedbackSelectionValue$,
  setFeedbackSelectionListenersRef$,
  setFeedbackSelectionToolbarRef$,
  startFeedback$,
  type FeedbackSelection,
} from "../../signals/zero-page/chat-feedback.ts";

function anchorStyle(selection: FeedbackSelection): CSSProperties {
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
  copied,
  onCopy,
  onProvideFeedback,
}: {
  copied: boolean;
  onCopy: () => void;
  onProvideFeedback: () => void;
}) {
  return (
    <PopoverContent
      side="top"
      align="center"
      sideOffset={8}
      onOpenAutoFocus={(event) => {
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
          {copied ? (
            <IconCheck size={14} stroke={2} />
          ) : (
            <IconCopy size={14} stroke={2} />
          )}
          {copied ? "Copied" : "Copy"}
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
          Provide feedback
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
export function ChatFeedbackSelection() {
  const selection = useGet(feedbackSelectionValue$);
  const copied = useGet(feedbackCopiedValue$);
  const rootSignal = useGet(rootSignal$);
  const setFeedbackSelectionListenersRef = useSet(
    setFeedbackSelectionListenersRef$,
  );
  const setFeedbackSelectionToolbarRef = useSet(
    setFeedbackSelectionToolbarRef$,
  );
  const startFeedback = useSet(startFeedback$);
  const closeSelectionToolbar = useSet(closeFeedbackSelectionToolbar$);
  const copy = useSet(copyFeedbackSelection$);

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
            copied={copied}
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
