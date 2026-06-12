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
  dismissFeedbackSelection$,
  feedbackCopiedValue$,
  feedbackItemsValue$,
  feedbackSelectionValue$,
  feedbackSendCountValue$,
  removeFeedbackItem$,
  setFeedbackItemNote$,
  startFeedback$,
  submitFeedback$,
  type FeedbackItem,
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

// One quoted fragment and its note. Every fragment renders identically — a
// quote line above a borderless, composer-styled note input — so the tray reads
// as a single stack of comments rather than a mix of cards and a bare field.
function FeedbackRow({
  item,
  autoFocus,
  onChangeNote,
  onRemove,
  onKeyDown,
}: {
  item: FeedbackItem;
  autoFocus: boolean;
  onChangeNote: (note: string) => void;
  onRemove: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  return (
    <div className="border-b border-dashed border-border/60 pb-2 pt-1 last:border-b-0">
      <div className="flex items-center gap-2">
        <span className="h-3.5 w-[3px] shrink-0 rounded-sm bg-primary" />
        <span className="min-w-0 flex-1 truncate text-xs italic leading-snug text-muted-foreground">
          {item.quote}
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove feedback"
          title="Remove feedback"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <IconX size={15} stroke={2} />
        </button>
      </div>
      <textarea
        ref={autoFocus ? focusOnMountRef : undefined}
        value={item.note}
        onChange={(event) => {
          return onChangeNote(event.target.value);
        }}
        onKeyDown={onKeyDown}
        rows={1}
        placeholder="What should change about this?"
        className="mt-1 w-full resize-none border-0 bg-transparent px-1 py-1 text-[0.9375rem] leading-snug text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-0"
      />
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

// The docked feedback tray: a consistent stack of quoted fragments — newest on
// top, each with its own note — and a single Send that dispatches them as one
// turn. Sits flush above the composer and survives thread scrolling.
export function ChatFeedbackTray({
  onSubmit,
}: {
  onSubmit: (prompt: string) => void;
}) {
  const items = useGet(feedbackItemsValue$);
  const sendCount = useGet(feedbackSendCountValue$);
  const setNote = useSet(setFeedbackItemNote$);
  const removeItem = useSet(removeFeedbackItem$);
  const submit = useSet(submitFeedback$);
  const dismiss = useSet(dismissFeedback$);

  if (items.length === 0) {
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

  // Oldest fragment sits on top; the stack runs down to the newest, which
  // takes the composer position nearest the Send button and holds focus.
  const newestId = items[items.length - 1]?.id;
  const ordered = items;

  return (
    <div className="shrink-0 px-4 pb-0 pt-2 sm:px-6">
      <div className="mx-auto max-w-[900px]">
        <div className="rounded-t-xl border border-b-0 border-border bg-popover px-3 pb-1 pt-1.5 shadow-[0_-2px_12px_rgba(15,23,42,0.05)]">
          <div className="flex flex-col">
            {ordered.map((item) => {
              return (
                <FeedbackRow
                  key={item.id}
                  item={item}
                  autoFocus={item.id === newestId}
                  onChangeNote={(note) => {
                    return setNote({ id: item.id, note });
                  }}
                  onRemove={() => {
                    return removeItem(item.id);
                  }}
                  onKeyDown={handleKeyDown}
                />
              );
            })}
          </div>
          <div className="flex items-center justify-between gap-3 pt-1.5">
            <span className="text-xs leading-snug text-muted-foreground">
              Select more text and click Provide feedback to add another comment
            </span>
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={sendCount === 0}
              aria-label="Send feedback"
              className="h-9 w-9 shrink-0 rounded-lg p-0"
            >
              <IconArrowUp size={18} stroke={2} />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
