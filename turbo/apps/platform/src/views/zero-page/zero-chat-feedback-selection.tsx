import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  RefCallback,
} from "react";
import {
  IconArrowUp,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconMessageCircle,
  IconX,
} from "@tabler/icons-react";
import { useGet, useSet } from "ccstate-react";
import {
  Button,
  cn,
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
  dismissFeedbackSelection$,
  editFeedbackComment$,
  feedbackActiveValue$,
  feedbackCommentsValue$,
  feedbackCopiedValue$,
  feedbackDraftValue$,
  feedbackEditingIdValue$,
  feedbackExpandedValue$,
  feedbackSelectionValue$,
  feedbackSendCountValue$,
  removeFeedbackComment$,
  setFeedbackDraftNote$,
  startFeedback$,
  submitFeedback$,
  toggleFeedbackExpanded$,
  type FeedbackComment,
  type FeedbackSelection,
} from "../../signals/zero-page/chat-feedback.ts";

// Watches document selection (and dismisses the toolbar on scroll) for the
// whole thread, via a ref on a persistent hidden node — the platform's
// listener-lifecycle idiom in place of an effect.
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

// A committed comment: its quoted passage above the note. Clicking reopens it
// for editing; the × removes it.
function FeedbackCommentCard({
  comment,
  editing,
  onEdit,
  onRemove,
}: {
  comment: FeedbackComment;
  editing: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative rounded-lg border bg-background transition-colors",
        editing
          ? "border-[hsl(var(--gray-400))] bg-gray-50"
          : "border-border hover:bg-gray-50",
      )}
    >
      <button
        type="button"
        onClick={onEdit}
        className="block w-full px-3 py-2 text-left"
      >
        <span className="mb-1 line-clamp-2 border-l-2 border-border pl-2 text-[11px] italic leading-snug text-muted-foreground">
          {comment.quote}
        </span>
        <span className="block pr-6 text-[13px] leading-snug text-foreground">
          {comment.note}
        </span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove comment"
        title="Remove comment"
        className="absolute right-1.5 top-1.5 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-colors hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
      >
        <IconX size={15} stroke={2} />
      </button>
    </div>
  );
}

// Committed comments collapse to a one-line summary so the tray stays short and
// the reply behind it stays visible. Expanding (or editing) reveals the bounded,
// scrollable list.
function FeedbackCommentSummary({
  comments,
  editingId,
  expanded,
  onToggle,
  onEdit,
  onRemove,
}: {
  comments: readonly FeedbackComment[];
  editingId: number | null;
  expanded: boolean;
  onToggle: () => void;
  onEdit: (id: number) => void;
  onRemove: (id: number) => void;
}) {
  const showList = expanded || editingId !== null;
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
      >
        <span>
          {comments.length === 1 ? "1 comment" : `${comments.length} comments`}
        </span>
        {showList ? (
          <IconChevronDown size={15} stroke={2} />
        ) : (
          <IconChevronRight size={15} stroke={2} />
        )}
      </button>
      {showList ? (
        <div className="mt-2 flex max-h-44 flex-col gap-2 overflow-y-auto pr-0.5">
          {comments.map((comment) => {
            return (
              <FeedbackCommentCard
                key={comment.id}
                comment={comment}
                editing={editingId === comment.id}
                onEdit={() => {
                  return onEdit(comment.id);
                }}
                onRemove={() => {
                  return onRemove(comment.id);
                }}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// Mounts the selection listeners and the floating Copy / Provide feedback
// toolbar anchored to the highlighted passage.
export function ChatFeedbackSelection() {
  const selection = useGet(feedbackSelectionValue$);
  const copied = useGet(feedbackCopiedValue$);
  const rootSignal = useGet(rootSignal$);
  const capture = useSet(captureFeedbackSelection$);
  const dismissOnScroll = useSet(dismissFeedbackOnScroll$);
  const startFeedback = useSet(startFeedback$);
  const dismissSelection = useSet(dismissFeedbackSelection$);
  const copy = useSet(copyFeedbackSelection$);

  return (
    <>
      <span ref={selectionListenersRef(capture, dismissOnScroll)} hidden />
      {selection ? (
        <Popover
          open
          onOpenChange={(next) => {
            if (!next) {
              dismissSelection();
            }
          }}
        >
          <PopoverAnchor asChild>
            <div style={anchorStyle(selection)} aria-hidden />
          </PopoverAnchor>
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

// The docked feedback tray: accumulated comment cards, the draft editor for the
// current passage, and a single "Send" that dispatches them as one turn. Sits
// above the composer and survives thread scrolling.
export function ChatFeedbackTray({
  onSubmit,
}: {
  onSubmit: (prompt: string) => void;
}) {
  const active = useGet(feedbackActiveValue$);
  const comments = useGet(feedbackCommentsValue$);
  const draft = useGet(feedbackDraftValue$);
  const editingId = useGet(feedbackEditingIdValue$);
  const sendCount = useGet(feedbackSendCountValue$);
  const expanded = useGet(feedbackExpandedValue$);
  const setNote = useSet(setFeedbackDraftNote$);
  const editComment = useSet(editFeedbackComment$);
  const removeComment = useSet(removeFeedbackComment$);
  const toggleExpanded = useSet(toggleFeedbackExpanded$);
  const submit = useSet(submitFeedback$);
  const dismiss = useSet(dismissFeedback$);

  if (!active) {
    return null;
  }

  const handleSubmit = () => {
    const prompt = submit();
    if (prompt === null) {
      return;
    }
    onSubmit(prompt);
    dismiss();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter inserts a newline — matching the main composer.
    // Escape closes the tray.
    if (matchShortcut("enter", event)) {
      event.preventDefault();
      handleSubmit();
    } else if (matchShortcut("escape", event)) {
      event.preventDefault();
      dismiss();
    }
  };

  return (
    <div className="shrink-0 px-4 pb-1 pt-2 sm:px-6">
      <div className="mx-auto max-w-[900px]">
        <div className="rounded-xl border border-border bg-popover p-3 shadow-lg">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground">
              Feedback on this reply
            </span>
            <button
              type="button"
              onClick={dismiss}
              aria-label="Close"
              title="Close"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <IconX size={18} stroke={1.8} />
            </button>
          </div>

          {comments.length > 0 ? (
            <FeedbackCommentSummary
              comments={comments}
              editingId={editingId}
              expanded={expanded}
              onToggle={toggleExpanded}
              onEdit={editComment}
              onRemove={removeComment}
            />
          ) : null}

          {draft ? (
            <>
              <blockquote className="mb-3 max-h-28 overflow-y-auto rounded-r-md border-l-[3px] border-border bg-muted/40 px-3 py-2 text-xs italic leading-5 text-muted-foreground">
                {draft.quote}
              </blockquote>
              <textarea
                key={draft.quote}
                ref={focusOnMountRef}
                value={draft.note}
                onChange={(event) => {
                  return setNote(event.target.value);
                }}
                onKeyDown={handleKeyDown}
                rows={2}
                placeholder="What should change about this?"
                className="w-full resize-none rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 focus:border-primary focus:outline-none focus:ring-[3px] focus:ring-primary/10"
              />
            </>
          ) : null}

          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-xs leading-snug text-muted-foreground">
              Select more text and click Provide feedback to add another comment
            </span>
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={sendCount === 0}
              className="shrink-0 gap-1.5"
            >
              <IconArrowUp size={14} stroke={2} />
              {sendCount === 0
                ? "Send"
                : sendCount === 1
                  ? "Send 1 comment"
                  : `Send ${sendCount} comments`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
