import type { CSSProperties } from "react";
import { Copy, Forward, MessageCircle } from "lucide-react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  getShortcutParts,
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@okouai/ui";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { detach, Reason } from "../../signals/utils.ts";
import type {
  ChatThreadFeedbackSelection,
  ChatThreadFeedbackSignals,
} from "../../signals/chat-page/chat-thread-feedback.ts";
import { ChatForwardDialog } from "./chat-forward-dialog.tsx";

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
  onForward,
}: {
  onCopy: () => void;
  onProvideFeedback: () => void;
  onForward?: () => void;
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
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-state-hover hover:text-accent-foreground"
        >
          <Copy size={14} />
          {t(($) => {
            return $.chat.actions.copy;
          })}
          <ShortcutHint shortcut="c" />
        </button>
        <div className="h-4 w-px bg-border" />
        <button
          type="button"
          onClick={onProvideFeedback}
          aria-keyshortcuts="q"
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-state-hover hover:text-accent-foreground"
        >
          <MessageCircle size={14} />
          {t(($) => {
            return $.chat.feedback.quote;
          })}
          <ShortcutHint shortcut="q" />
        </button>
        {onForward ? (
          <>
            <div className="h-4 w-px bg-border" />
            <button
              type="button"
              onClick={onForward}
              aria-keyshortcuts="f"
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-state-hover hover:text-accent-foreground"
            >
              <Forward size={14} />
              {t(($) => {
                return $.chat.forward.action;
              })}
              <ShortcutHint shortcut="f" />
            </button>
          </>
        ) : null}
      </div>
    </PopoverContent>
  );
}

// Mounts the selection listeners and the floating Copy / Quote / Forward
// toolbar anchored to the selected passage. Picking "Quote"
// drops the quoted passage straight into the composer (see ComposerFeedbackRows
// in zero-chat-composer.tsx) — there is no separate feedback panel.
export function ChatFeedbackSelection({
  feedback,
  sourceAgentId,
  sourceThreadTitle,
}: {
  readonly feedback: ChatThreadFeedbackSignals;
  readonly sourceAgentId: string;
  readonly sourceThreadTitle: string;
}) {
  const selection = useGet(feedback.selection$);
  const forwardSelection = useGet(feedback.forwardSelection$);
  const forwardComposerState = useGet(feedback.forwardComposerState$);
  const forwardEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.ChatForward] ?? false;
  const rootSignal = useGet(rootSignal$);
  const setFeedbackSelectionListenersRef = useSet(feedback.setListenersRef$);
  const setFeedbackSelectionToolbarRef = useSet(feedback.setToolbarRef$);
  const startFeedback = useSet(feedback.start$);
  const closeSelectionToolbar = useSet(feedback.close$);
  const copy = useSet(feedback.copy$);
  const startForward = useSet(feedback.startForward$);
  const setForwardComposerState = useSet(feedback.setForwardComposerState$);
  const closeForward = useSet(feedback.closeForward$);

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
            onForward={
              forwardEnabled && selection.threadId && selection.runId
                ? startForward
                : undefined
            }
          />
        </Popover>
      ) : null}
      {forwardSelection ? (
        <ChatForwardDialog
          selection={forwardSelection}
          composerState={forwardComposerState}
          sourceAgentId={sourceAgentId}
          sourceThreadTitle={sourceThreadTitle}
          onComposerStateChange={setForwardComposerState}
          onDismiss={() => {
            closeForward();
          }}
        />
      ) : null}
    </>
  );
}
