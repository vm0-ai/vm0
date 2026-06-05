import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  RefCallback,
} from "react";
import {
  IconArrowUp,
  IconCheck,
  IconCopy,
  IconMessageCircle,
  IconX,
} from "@tabler/icons-react";
import { useGet, useSet } from "ccstate-react";
import {
  Button,
  Popover,
  PopoverAnchor,
  PopoverContent,
  matchShortcut,
} from "@vm0/ui";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  captureFeedbackSelection$,
  copyFeedbackSelection$,
  dismissFeedback$,
  dismissFeedbackOnScroll$,
  feedbackCommentValue$,
  feedbackCopiedValue$,
  feedbackModeValue$,
  feedbackSelectionValue$,
  openFeedbackComposer$,
  setFeedbackComment$,
  type FeedbackSelection,
} from "../../signals/zero-page/chat-feedback.ts";

// Compose the quoted passage and the user's note into a single follow-up turn.
function formatFeedbackPrompt(quote: string, comment: string): string {
  const quoted = quote
    .split("\n")
    .map((line) => {
      return `> ${line}`;
    })
    .join("\n");
  return `Feedback on this part of your reply:\n\n${quoted}\n\n${comment}`;
}

// Watches document selection (and dismisses on scroll) for the whole thread,
// via a ref on a persistent hidden node — the platform's listener-lifecycle
// idiom in place of an effect.
function selectionListenersRef(
  capture: () => void,
  dismissOnScroll: () => void,
): RefCallback<HTMLSpanElement> {
  let detachListeners: (() => void) | null = null;
  return (element) => {
    detachListeners?.();
    detachListeners = null;
    if (!element) {
      return;
    }
    document.addEventListener("mouseup", capture);
    document.addEventListener("keyup", capture);
    document.addEventListener("scroll", dismissOnScroll, {
      capture: true,
      passive: true,
    });
    detachListeners = () => {
      document.removeEventListener("mouseup", capture);
      document.removeEventListener("keyup", capture);
      document.removeEventListener("scroll", dismissOnScroll, {
        capture: true,
      });
    };
  };
}

function focusOnMountRef(element: HTMLTextAreaElement | null): void {
  element?.focus();
}

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
      className="w-auto rounded-xl border-0 bg-foreground p-1 text-background shadow-lg"
    >
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-background/10"
        >
          {copied ? (
            <IconCheck size={14} stroke={2} />
          ) : (
            <IconCopy size={14} stroke={2} />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
        <div className="h-4 w-px bg-background/20" />
        <button
          type="button"
          onClick={onProvideFeedback}
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-background/10"
        >
          <IconMessageCircle size={14} stroke={2} />
          Provide feedback
        </button>
      </div>
    </PopoverContent>
  );
}

function FeedbackComposer({
  quote,
  comment,
  onCommentChange,
  onSubmit,
  onDismiss,
}: {
  quote: string;
  comment: string;
  onCommentChange: (value: string) => void;
  onSubmit: () => void;
  onDismiss: () => void;
}) {
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter inserts a newline — matching the main composer.
    if (matchShortcut("enter", event)) {
      event.preventDefault();
      onSubmit();
    } else if (matchShortcut("escape", event)) {
      event.preventDefault();
      onDismiss();
    }
  };
  return (
    <PopoverContent
      side="top"
      align="center"
      sideOffset={8}
      className="w-80 rounded-xl p-3"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-foreground">
          Provide feedback
        </span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="rounded-md p-0.5 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
        >
          <IconX size={14} stroke={2} />
        </button>
      </div>
      <blockquote className="mb-3 max-h-24 overflow-y-auto rounded-r-md border-l-[3px] border-border bg-muted/40 px-3 py-2 text-xs italic leading-5 text-muted-foreground">
        {quote}
      </blockquote>
      <textarea
        ref={focusOnMountRef}
        value={comment}
        onChange={(event) => {
          return onCommentChange(event.target.value);
        }}
        onKeyDown={handleKeyDown}
        rows={2}
        placeholder="What should change about this?"
        className="w-full resize-none rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 focus:border-primary focus:outline-none focus:ring-[3px] focus:ring-primary/10"
      />
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={onSubmit}
          disabled={comment.trim().length === 0}
          className="gap-1.5"
        >
          <IconArrowUp size={14} stroke={2} />
          Send feedback
        </Button>
      </div>
    </PopoverContent>
  );
}

export function ChatFeedbackSelection({
  onSubmit,
}: {
  onSubmit: (prompt: string) => void;
}) {
  const selection = useGet(feedbackSelectionValue$);
  const mode = useGet(feedbackModeValue$);
  const comment = useGet(feedbackCommentValue$);
  const copied = useGet(feedbackCopiedValue$);
  const rootSignal = useGet(rootSignal$);
  const capture = useSet(captureFeedbackSelection$);
  const dismissOnScroll = useSet(dismissFeedbackOnScroll$);
  const dismiss = useSet(dismissFeedback$);
  const openComposer = useSet(openFeedbackComposer$);
  const setComment = useSet(setFeedbackComment$);
  const copy = useSet(copyFeedbackSelection$);

  const handleSubmit = () => {
    if (!selection || comment.trim().length === 0) {
      return;
    }
    onSubmit(formatFeedbackPrompt(selection.text, comment.trim()));
    dismiss();
  };

  return (
    <>
      <span ref={selectionListenersRef(capture, dismissOnScroll)} hidden />
      {selection ? (
        <Popover
          open
          onOpenChange={(next) => {
            if (!next) {
              dismiss();
            }
          }}
        >
          <PopoverAnchor asChild>
            <div style={anchorStyle(selection)} aria-hidden />
          </PopoverAnchor>
          {mode === "toolbar" ? (
            <FeedbackToolbar
              copied={copied}
              onCopy={() => {
                return detach(copy(rootSignal), Reason.DomCallback);
              }}
              onProvideFeedback={openComposer}
            />
          ) : (
            <FeedbackComposer
              quote={selection.text}
              comment={comment}
              onCommentChange={setComment}
              onSubmit={handleSubmit}
              onDismiss={dismiss}
            />
          )}
        </Popover>
      ) : null}
    </>
  );
}
