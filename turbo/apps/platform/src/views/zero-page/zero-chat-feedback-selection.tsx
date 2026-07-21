import type { CSSProperties } from "react";
import { IconArrowUp, IconCopy, IconMessageCircle } from "@tabler/icons-react";
import { useGet, useSet } from "ccstate-react";
import {
  getShortcutParts,
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@vm0/ui";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import type {
  FeedbackSelection,
  FeedbackSignals,
} from "../../signals/zero-page/chat-feedback.ts";
import { MicButton } from "./zero-chat-composer.tsx";

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
  onCopy,
  onProvideFeedback,
  feedbackMessageCardsEnabled,
}: {
  onCopy: () => void;
  onProvideFeedback: () => void;
  feedbackMessageCardsEnabled: boolean;
}) {
  const feedbackShortcut = feedbackMessageCardsEnabled ? "q" : "f";
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
          Copy
          <ShortcutHint shortcut="c" />
        </button>
        <div className="h-4 w-px bg-border" />
        <button
          type="button"
          onClick={onProvideFeedback}
          aria-keyshortcuts={
            feedbackMessageCardsEnabled ? "q f" : feedbackShortcut
          }
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <IconMessageCircle size={14} stroke={2} />
          Provide feedback
          <ShortcutHint shortcut={feedbackShortcut} />
        </button>
      </div>
    </PopoverContent>
  );
}

// Codex-style inline input, shown beside the selection after "Provide feedback"
// so the comment is written next to the quoted passage before it becomes a chip
// in the composer. Gated behind the feedbackMessageCards switch.
function FeedbackInputPopover({
  note,
  onChange,
  onSubmit,
  onCancel,
}: {
  note: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <PopoverContent
      side="bottom"
      align="start"
      sideOffset={8}
      data-feedback-input=""
      onCloseAutoFocus={(event) => {
        return event.preventDefault();
      }}
      onEscapeKeyDown={(event) => {
        event.preventDefault();
        onCancel();
      }}
      className="group/feedback-input w-[min(20rem,calc(100vw-2rem))] rounded-2xl border border-border bg-card px-3 py-1 text-foreground shadow-md has-[textarea[data-multiline=true]]:rounded-[1.75rem] has-[textarea[data-multiline=true]]:px-5 has-[textarea[data-multiline=true]]:py-4"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-end gap-1 group-has-[textarea[data-multiline=true]]/feedback-input:min-h-40 group-has-[textarea[data-multiline=true]]/feedback-input:grid-rows-[auto_1fr_auto] [&_button]:h-8 [&_button]:w-8">
        <textarea
          autoFocus
          ref={(element) => {
            resizeFeedbackTextarea(element);
          }}
          rows={1}
          value={note}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) {
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSubmit();
            }
          }}
          placeholder="Add an optional comment..."
          aria-label="Add an optional comment"
          className="col-start-1 row-start-1 max-h-32 min-h-8 min-w-0 resize-none overflow-y-hidden whitespace-pre-wrap break-words bg-transparent py-1.5 text-sm leading-5 outline-none placeholder:text-muted-foreground/45 group-has-[textarea[data-multiline=true]]/feedback-input:col-span-3 group-has-[textarea[data-multiline=true]]/feedback-input:w-full group-has-[textarea[data-multiline=true]]/feedback-input:py-0"
        />
        <div className="col-start-2 row-start-1 group-has-[textarea[data-multiline=true]]/feedback-input:row-start-3">
          <MicButton
            owner="feedback"
            onTranscribed={(text) => {
              onChange([note.trim(), text.trim()].filter(Boolean).join(" "));
            }}
          />
        </div>
        {note.trim() ? (
          <button
            type="button"
            onClick={onSubmit}
            aria-label="Send feedback"
            className="col-start-3 row-start-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-has-[textarea[data-multiline=true]]/feedback-input:row-start-3"
          >
            <IconArrowUp size={18} stroke={2} />
          </button>
        ) : null}
      </div>
    </PopoverContent>
  );
}

function resizeFeedbackTextarea(element: HTMLTextAreaElement | null): void {
  if (!element) {
    return;
  }
  const maxHeight = 128;
  element.style.height = "auto";
  const height = Math.min(Math.max(element.scrollHeight, 32), maxHeight);
  element.dataset.multiline = height > 32 ? "true" : "false";
  element.style.height = `${height}px`;
  element.style.overflowY =
    element.scrollHeight > maxHeight ? "auto" : "hidden";
}

// Mounts the selection listeners and the floating Copy / Provide feedback
// toolbar anchored to the highlighted passage. With the feedbackMessageCards
// switch off, "Provide feedback" drops the quoted passage straight into the
// composer; with it on, it opens the inline input above before the passage
// becomes a chip.
export function ChatFeedbackSelection({
  feedback,
  onDraftChange,
}: {
  readonly feedback: FeedbackSignals;
  readonly onDraftChange?: () => void;
}) {
  const selection = useGet(feedback.selection$);
  const rootSignal = useGet(rootSignal$);
  const inlineInputEnabled = feedback.feedbackMessageCardsEnabled;
  const draftOpen = useGet(feedback.draftOpen$);
  const draftNote = useGet(feedback.draftNote$);
  const setFeedbackSelectionListenersRef = useSet(
    feedback.setSelectionListenersRef$,
  );
  const setFeedbackSelectionToolbarRef = useSet(
    feedback.setSelectionToolbarRef$,
  );
  const startFeedback = useSet(feedback.startFeedback$);
  const openDraft = useSet(feedback.openFeedbackDraft$);
  const setDraftNote = useSet(feedback.setFeedbackDraftNote$);
  const submitDraft = useSet(feedback.submitFeedbackDraft$);
  const cancelDraft = useSet(feedback.cancelFeedbackDraft$);
  const dismissDraft = useSet(feedback.dismissFeedbackDraft$);
  const closeSelectionToolbar = useSet(feedback.closeSelectionToolbar$);
  const copy = useSet(feedback.copySelection$);

  const showInlineInput = inlineInputEnabled && draftOpen;
  const handleSubmitDraft = () => {
    submitDraft();
    onDraftChange?.();
  };

  return (
    <>
      <span ref={setFeedbackSelectionListenersRef} hidden />
      {selection ? (
        <Popover
          open
          onOpenChange={(next) => {
            if (!next) {
              if (showInlineInput) {
                dismissDraft();
              } else {
                closeSelectionToolbar();
              }
            }
          }}
        >
          <PopoverAnchor asChild>
            <div style={anchorStyle(selection)} aria-hidden />
          </PopoverAnchor>
          <span ref={setFeedbackSelectionToolbarRef} hidden />
          {showInlineInput ? (
            <FeedbackInputPopover
              note={draftNote}
              onChange={setDraftNote}
              onSubmit={handleSubmitDraft}
              onCancel={cancelDraft}
            />
          ) : (
            <FeedbackToolbar
              onCopy={() => {
                return detach(copy(rootSignal), Reason.DomCallback);
              }}
              onProvideFeedback={inlineInputEnabled ? openDraft : startFeedback}
              feedbackMessageCardsEnabled={inlineInputEnabled}
            />
          )}
        </Popover>
      ) : null}
    </>
  );
}
