import type { CSSProperties, RefCallback } from "react";
import { IconCheck, IconCopy, IconMessageCircle } from "@tabler/icons-react";
import { useGet, useSet } from "ccstate-react";
import { Popover, PopoverAnchor, PopoverContent } from "@vm0/ui";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  captureFeedbackSelection$,
  copyFeedbackSelection$,
  dismissFeedbackOnScroll$,
  dismissFeedbackSelection$,
  feedbackCopiedValue$,
  feedbackSelectionValue$,
  startFeedback$,
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

// Mounts the selection listeners and the floating Copy / Provide feedback
// toolbar anchored to the highlighted passage. Picking "Provide feedback"
// drops the quoted passage straight into the composer (see ComposerFeedbackRows
// in zero-chat-composer.tsx) — there is no separate feedback panel.
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
