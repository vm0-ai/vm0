import type { CSSProperties, ReactNode } from "react";
import {
  Copy,
  Forward,
  Languages,
  Loader2,
  MessageCircle,
  X,
} from "lucide-react";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  getShortcutParts,
  Popover,
  PopoverAnchor,
  PopoverContent,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui";
import {
  CHAT_TRANSLATION_LANGUAGES,
  chatTranslationLanguageSchema,
  type ChatTranslationLanguage,
} from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { detach, Reason } from "../../signals/utils.ts";
import type {
  ChatThreadFeedbackSelection,
  ChatThreadFeedbackSignals,
  ChatThreadTranslationResult,
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
  translation,
}: {
  onCopy: () => void;
  onProvideFeedback: () => void;
  onForward?: () => void;
  translation?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
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
      {translation ? (
        <>
          <div className="h-4 w-px bg-border" />
          {translation}
        </>
      ) : null}
    </div>
  );
}

function TranslationLanguageSelect({
  value,
  disabled,
  onChange,
}: {
  readonly value: ChatTranslationLanguage;
  readonly disabled: boolean;
  readonly onChange: (value: ChatTranslationLanguage) => void;
}) {
  const { t } = useTranslation();
  const labelFor = (itemValue: ChatTranslationLanguage): string => {
    switch (itemValue) {
      case "en": {
        return t(($) => {
          return $.chat.translation.languages.en;
        });
      }
      case "zh-CN": {
        return t(($) => {
          return $.chat.translation.languages.zhCN;
        });
      }
      case "zh-TW": {
        return t(($) => {
          return $.chat.translation.languages.zhTW;
        });
      }
      case "ja": {
        return t(($) => {
          return $.chat.translation.languages.ja;
        });
      }
      case "ko": {
        return t(($) => {
          return $.chat.translation.languages.ko;
        });
      }
      case "es": {
        return t(($) => {
          return $.chat.translation.languages.es;
        });
      }
      case "fr": {
        return t(($) => {
          return $.chat.translation.languages.fr;
        });
      }
      case "de": {
        return t(($) => {
          return $.chat.translation.languages.de;
        });
      }
      case "pt-BR": {
        return t(($) => {
          return $.chat.translation.languages.ptBR;
        });
      }
      case "it": {
        return t(($) => {
          return $.chat.translation.languages.it;
        });
      }
      case "id": {
        return t(($) => {
          return $.chat.translation.languages.id;
        });
      }
      case "hi": {
        return t(($) => {
          return $.chat.translation.languages.hi;
        });
      }
    }
  };
  const items = CHAT_TRANSLATION_LANGUAGES.map((itemValue) => {
    return { value: itemValue, label: labelFor(itemValue) };
  });
  return (
    <Select
      items={items}
      value={value}
      disabled={disabled}
      onValueChange={(nextValue) => {
        onChange(chatTranslationLanguageSchema.parse(nextValue));
      }}
    >
      <SelectTrigger
        aria-label={t(($) => {
          return $.chat.translation.targetLanguage;
        })}
        className="h-7 w-[112px] border-0 bg-gray-50 px-2 py-1 text-xs shadow-none transition-colors hover:bg-state-hover"
      >
        <SelectValue />
      </SelectTrigger>
      {/* Seven 32px rows plus their gaps, list padding, and popup borders. */}
      <SelectContent
        data-chat-selection-interaction
        hideScrollButtons
        className="max-h-[258px] overscroll-contain"
      >
        {items.map((item) => {
          return (
            <SelectItem
              key={item.value}
              value={item.value}
              className="h-8 whitespace-nowrap"
            >
              {item.label}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

function TranslationAction({
  feedback,
}: {
  readonly feedback: ChatThreadFeedbackSignals;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const translate = useSet(feedback.translate$);
  const translating = useTranslationLoading(feedback);
  return (
    <button
      type="button"
      disabled={translating}
      onClick={() => {
        detach(translate(pageSignal), Reason.DomCallback);
      }}
      aria-keyshortcuts="t"
      className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-state-hover hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
    >
      {translating ? (
        <Loader2 size={14} className="animate-spin" aria-hidden />
      ) : (
        <Languages size={14} />
      )}
      {t(($) => {
        return $.chat.translation.action;
      })}
      <ShortcutHint shortcut="t" />
    </button>
  );
}

function useTranslationLoading(feedback: ChatThreadFeedbackSignals): boolean {
  const translationPromise = useGet(feedback.translationPromise$);
  const translationLoadable = useLoadable(feedback.translationPromise$);
  return translationPromise !== null && translationLoadable.state === "loading";
}

function TranslationResult({
  feedback,
  result,
  onClose,
}: {
  readonly feedback: ChatThreadFeedbackSignals;
  readonly result: ChatThreadTranslationResult;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const rootSignal = useGet(rootSignal$);
  const [languageLoadable, setLanguage] = useLoadableSet(
    feedback.setTranslationLanguage$,
  );
  const translate = useSet(feedback.translate$);
  const language =
    useLastResolved(feedback.translationLanguage$) ?? result.targetLanguage;
  const translating = useTranslationLoading(feedback);
  const updatingLanguage = languageLoadable.state === "loading" || translating;
  const copyTranslation = useSet(feedback.copyTranslation$);
  return (
    <>
      <div className="mb-2 flex items-center gap-2">
        {updatingLanguage ? (
          <Loader2
            size={15}
            className="shrink-0 animate-spin text-muted-foreground"
            aria-hidden
          />
        ) : (
          <Languages size={15} className="shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 text-xs font-medium">
          {t(($) => {
            return $.chat.translation.result;
          })}
        </span>
        <TranslationLanguageSelect
          value={language}
          disabled={updatingLanguage}
          onChange={(nextLanguage) => {
            detach(
              (async () => {
                await setLanguage(nextLanguage, pageSignal);
                await translate(pageSignal);
              })(),
              Reason.DomCallback,
            );
          }}
        />
        <button
          type="button"
          onClick={() => {
            detach(copyTranslation(rootSignal), Reason.DomCallback);
          }}
          aria-label={t(($) => {
            return $.chat.translation.copy;
          })}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-gray-50 hover:text-foreground"
        >
          <Copy size={14} />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={t(($) => {
            return $.chat.translation.close;
          })}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-gray-50 hover:text-foreground"
        >
          <X size={14} />
        </button>
      </div>
      <p
        aria-busy={updatingLanguage}
        className="max-h-64 overflow-y-auto whitespace-pre-wrap text-sm leading-6 transition-opacity aria-busy:opacity-60"
      >
        {result.text}
      </p>
    </>
  );
}

// Mounts the selection listeners and the floating Copy / Quote / Forward
// toolbar anchored to the selected passage. Picking "Quote"
// drops the quoted passage straight into the composer (see the feedback rows in
// chat-composer.tsx) — there is no separate feedback panel.
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
  const translationResult = useGet(feedback.translationResult$);
  const translationEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.ChatTranslation];
  const forwardSelection = useGet(feedback.forwardSelection$);
  const forwardComposerState = useGet(feedback.forwardComposerState$);
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
          onOpenChange={(next, eventDetails) => {
            if (!next) {
              const eventTarget = eventDetails.event.target;
              if (
                eventTarget instanceof Element &&
                eventTarget.closest("[data-chat-selection-interaction]")
              ) {
                eventDetails.cancel();
                return;
              }
              closeSelectionToolbar();
            }
          }}
        >
          <PopoverAnchor asChild>
            <div style={anchorStyle(selection)} aria-hidden />
          </PopoverAnchor>
          <span ref={setFeedbackSelectionToolbarRef} hidden />
          <PopoverContent
            data-chat-selection-interaction
            side="top"
            align="center"
            sideOffset={8}
            onOpenAutoFocus={(event) => {
              return event.preventDefault();
            }}
            onCloseAutoFocus={(event) => {
              return event.preventDefault();
            }}
            className={
              translationEnabled && translationResult
                ? "w-[min(380px,calc(100vw-2rem))] rounded-xl border-[0.7px] border-[hsl(var(--gray-400))] bg-[hsl(var(--card)/0.96)] p-3 text-foreground shadow-lg"
                : "w-auto rounded-xl border-[0.7px] border-[hsl(var(--gray-400))] bg-[hsl(var(--card)/0.85)] p-1 text-foreground shadow-lg"
            }
          >
            {translationEnabled && translationResult ? (
              <TranslationResult
                feedback={feedback}
                result={translationResult}
                onClose={closeSelectionToolbar}
              />
            ) : (
              <FeedbackToolbar
                onCopy={() => {
                  return detach(copy(rootSignal), Reason.DomCallback);
                }}
                onProvideFeedback={startFeedback}
                onForward={
                  selection.threadId && selection.runId
                    ? startForward
                    : undefined
                }
                translation={
                  translationEnabled ? (
                    <TranslationAction feedback={feedback} />
                  ) : undefined
                }
              />
            )}
          </PopoverContent>
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
