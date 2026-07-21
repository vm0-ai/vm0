import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import { IconQuote, IconX } from "@tabler/icons-react";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
  type KeyboardEventLike,
} from "@vm0/ui";
import { currentChatAgentRecordId$ } from "../../signals/agent-chat.ts";
import type { ComposerChatThreadSuggestion } from "../../signals/zero-page/chat-thread-suggestion-domain.ts";
import { composerChatThreadSuggestionsEnabled$ } from "../../signals/zero-page/composer-chat-thread-suggestions.ts";
import type { WorkflowComposerSignals } from "../../signals/zero-page/tiptap-workflow-composer.ts";
import { composerWorkflows$ } from "../../signals/workflows-page/workflows-signals.ts";
import {
  ChatThreadSuggestionMenu,
  scrollChatThreadSuggestionIntoView,
} from "./chat-thread-suggestion.tsx";
import {
  buildComposerSlashWorkflows,
  matchesWorkflowQuery,
  scrollSlashWorkflowIntoView,
  SlashWorkflowMenu,
  type ComposerSlashWorkflow,
} from "./slash-workflow.tsx";
import type { ComposerPasteEvent } from "./composer-input-types.ts";

function isMacKeyboard(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

function serializeTextblockSegment(
  node: ProseMirrorNode,
  from: number,
  to: number,
): string {
  return node.textBetween(from, to, "\n", (leafNode) => {
    return leafNode.type.name === "hardBreak" ? "\n" : "";
  });
}

function resolveMacControlLineNavigation(
  editor: Editor,
  event: KeyboardEvent,
): number | null {
  if (
    !isMacKeyboard() ||
    !event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey
  ) {
    return null;
  }
  const key = event.key.toLowerCase();
  if (key !== "a" && key !== "e") {
    return null;
  }
  const { $head } = editor.state.selection;
  const { parent, parentOffset } = $head;
  if (!parent.isTextblock) {
    return null;
  }
  const beforeCaret = serializeTextblockSegment(parent, 0, parentOffset);
  if (key === "a") {
    return $head.start() + beforeCaret.lastIndexOf("\n") + 1;
  }
  const afterCaret = serializeTextblockSegment(
    parent,
    parentOffset,
    parent.content.size,
  );
  const nextBreak = afterCaret.indexOf("\n");
  return (
    $head.start() +
    (nextBreak === -1 ? parent.content.size : parentOffset + nextBreak)
  );
}

interface ComposerSuggestionRange {
  readonly start: number;
  readonly end: number;
}

interface ComposerSuggestionCaretVirtualRef {
  current: {
    readonly contextElement: HTMLElement;
    getBoundingClientRect(): DOMRect;
  };
}

function composerSuggestionCaretVirtualRef(
  editor: Editor,
  range: ComposerSuggestionRange | null,
): ComposerSuggestionCaretVirtualRef | null {
  if (!range || !editor.isInitialized) {
    return null;
  }
  return {
    current: {
      contextElement: editor.view.dom,
      getBoundingClientRect() {
        const suggestionStart = Math.max(
          editor.state.selection.head - (range.end - range.start),
          0,
        );
        const coords = editor.view.coordsAtPos(suggestionStart);
        return new DOMRect(
          coords.left,
          coords.top,
          0,
          coords.bottom - coords.top,
        );
      },
    },
  };
}

function ComposerSuggestionCaretAnchor({
  editor,
  range,
}: {
  readonly editor: Editor;
  readonly range: ComposerSuggestionRange | null;
}) {
  const virtualRef = composerSuggestionCaretVirtualRef(editor, range);
  return virtualRef ? <PopoverAnchor virtualRef={virtualRef} /> : null;
}

function workflowComposerPlaceholder(sending: boolean | undefined): string {
  return sending
    ? "Type your next message…"
    : "Ask me to automate workflows, manage tasks...";
}

function WorkflowComposerPlaceholder({
  composer,
  sending,
}: {
  composer: WorkflowComposerSignals;
  sending: boolean | undefined;
}) {
  const hasInput = useGet(composer.hasInput$);
  const hasTemplateAttachment = useGet(composer.hasTemplateAttachment$);
  if (hasInput) {
    return null;
  }
  return (
    <div
      className={`pointer-events-none absolute left-0 px-4 text-[0.9375rem] leading-6 text-muted-foreground/40 ${
        hasTemplateAttachment ? "top-[54px]" : "top-0 pt-4"
      }`}
      aria-hidden="true"
    >
      {workflowComposerPlaceholder(sending)}
    </div>
  );
}

function FeedbackChipStrip({
  composer,
  onDraftChange,
}: {
  composer: WorkflowComposerSignals;
  onDraftChange: (() => void) | undefined;
}) {
  const items = useGet(composer.feedback.items$);
  const updateNote = useSet(composer.feedback.updateFeedbackNote$);
  const removeFeedback = useSet(composer.feedback.removeFeedback$);

  if (items.length === 0) {
    return null;
  }

  const label = `${String(items.length)} ${items.length === 1 ? "quote" : "quotes"}`;

  return (
    <div
      className="flex flex-wrap gap-1.5 px-4 pt-4"
      data-feedback-chip-strip=""
    >
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Open ${label}`}
            data-feedback-chip=""
            className="inline-flex h-9 max-w-56 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <IconQuote size={16} stroke={1.7} className="shrink-0" />
            <span className="truncate">{label}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="max-h-[min(28rem,70vh)] w-[min(32rem,calc(100vw-1.5rem))] max-w-none overflow-y-auto rounded-xl p-3 shadow-lg"
        >
          <div
            className="flex flex-col divide-y divide-border/60"
            data-feedback-comment-list=""
          >
            {items.map((item, index) => {
              return (
                <div
                  key={item.id}
                  data-feedback-item=""
                  className="py-3 first:pt-1 last:pb-1"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="whitespace-pre-wrap break-words border-l-2 border-foreground/15 pl-3 text-sm leading-5 text-muted-foreground">
                        {item.quote}
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-label={`Remove comment ${String(index + 1)}`}
                      onClick={() => {
                        removeFeedback(item.id);
                        onDraftChange?.();
                      }}
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <IconX size={15} stroke={1.7} />
                    </button>
                  </div>
                  <textarea
                    value={item.note}
                    onChange={(event) => {
                      updateNote(item.id, event.target.value);
                      onDraftChange?.();
                    }}
                    aria-label={`Feedback comment ${String(index + 1)}`}
                    placeholder="Add an optional comment..."
                    rows={2}
                    className="mt-2 max-h-28 min-h-10 w-full resize-none rounded-md border-0 bg-transparent px-2 py-1.5 text-sm leading-5 outline-none transition-colors placeholder:text-muted-foreground/50 hover:bg-muted/25 focus:bg-muted/40 focus:ring-1 focus:ring-primary/30"
                  />
                </div>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export interface TiptapWorkflowComposerProps {
  readonly composer: WorkflowComposerSignals;
  readonly onDraftChange: (() => void) | undefined;
  readonly sending: boolean | undefined;
  readonly autoFocus: boolean | undefined;
  readonly onKeyDown: (event: KeyboardEventLike) => void;
  readonly onPaste: (event: ComposerPasteEvent) => void;
  readonly singleLineOnMobile: boolean;
}

interface ComposerKeyDownContext {
  readonly composer: WorkflowComposerSignals;
  readonly suggestionCount: number;
  readonly selectedSuggestionIndex: number;
  readonly showSuggestionMenu: boolean;
  readonly setSelectedSuggestionIndex: (index: number) => void;
  readonly closeSuggestionMenu: () => void;
  readonly selectSuggestion: (index: number) => void;
  readonly scrollSuggestionIntoView: (index: number) => void;
  readonly onKeyDown: (event: KeyboardEventLike) => void;
}

function handleComposerKeyDownCapture(
  event: KeyboardEvent,
  context: ComposerKeyDownContext,
): boolean {
  if (event.isComposing || event.keyCode === 229) {
    context.onKeyDown(event);
    return event.defaultPrevented;
  }
  if (
    event.key === "Enter" &&
    event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  ) {
    event.preventDefault();
    context.composer.editor.commands.splitBlock();
    return true;
  }
  const lineNavigationPos = resolveMacControlLineNavigation(
    context.composer.editor,
    event,
  );
  if (lineNavigationPos !== null) {
    event.preventDefault();
    context.composer.editor.commands.setTextSelection(lineNavigationPos);
    return true;
  }
  if (!context.showSuggestionMenu) {
    context.onKeyDown(event);
    return event.defaultPrevented;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = Math.max(
      0,
      Math.min(
        context.selectedSuggestionIndex + delta,
        Math.max(context.suggestionCount - 1, 0),
      ),
    );
    context.setSelectedSuggestionIndex(next);
    context.scrollSuggestionIntoView(next);
    return true;
  }
  if (
    (event.key === "Enter" || event.key === "Tab") &&
    context.suggestionCount > 0
  ) {
    event.preventDefault();
    context.selectSuggestion(
      Math.min(context.selectedSuggestionIndex, context.suggestionCount - 1),
    );
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    context.closeSuggestionMenu();
    return true;
  }
  context.onKeyDown(event);
  return event.defaultPrevented;
}

interface ComposerSuggestionMenuState {
  readonly open: boolean;
  readonly range: ComposerSuggestionRange | null;
  readonly selectedIndex: number;
  readonly close: () => void;
  readonly workflowNames: readonly string[];
  readonly workflows: readonly ComposerSlashWorkflow[];
  readonly workflowQuery: string;
  readonly workflowsLoading: boolean;
  readonly showWorkflows: boolean;
  readonly chatThreads: readonly ComposerChatThreadSuggestion[];
  readonly showChatThreads: boolean;
  readonly selectWorkflow: (workflow: ComposerSlashWorkflow) => void;
  readonly selectChatThread: (chatThread: ComposerChatThreadSuggestion) => void;
  readonly handleKeyDown: (event: KeyboardEvent) => boolean;
}

function useComposerSuggestionMenu({
  composer,
  onDraftChange,
  onKeyDown,
}: {
  readonly composer: WorkflowComposerSignals;
  readonly onDraftChange: (() => void) | undefined;
  readonly onKeyDown: (event: KeyboardEventLike) => void;
}): ComposerSuggestionMenuState {
  const slashRange = useGet(composer.activeSlashRange$);
  const chatThreadRange = useGet(composer.activeChatThreadSuggestionRange$);
  const chatThreadResult = useLastResolved(composer.chatThreadSuggestions$);
  const chatThreadSuggestionsEnabled = useGet(
    composerChatThreadSuggestionsEnabled$,
  );
  const selectedIndex = useGet(composer.selectedSuggestionIndex$);
  const setSelectedIndex = useSet(composer.setSelectedSuggestionIndex$);
  const close = useSet(composer.closeSuggestionMenu$);
  const insertWorkflow = useSet(composer.insertWorkflow$);
  const insertChatThread = useSet(composer.insertChatThread$);
  const currentAgentId = useLastResolved(currentChatAgentRecordId$);
  const workflowsLoadable = useLastLoadable(composerWorkflows$);
  const workflows = buildComposerSlashWorkflows({
    agentId: currentAgentId,
    workflows:
      workflowsLoadable.state === "hasData" ? workflowsLoadable.data : [],
  });
  const workflowSuggestions = slashRange
    ? workflows.filter((workflow) => {
        return matchesWorkflowQuery(workflow, slashRange.query);
      })
    : [];
  const showWorkflows = slashRange !== null;
  const chatThreads =
    chatThreadSuggestionsEnabled &&
    chatThreadRange &&
    chatThreadResult &&
    chatThreadResult.agentId === currentAgentId &&
    chatThreadResult.query === chatThreadRange.query
      ? chatThreadResult.chatThreads
      : [];
  const showChatThreads =
    slashRange === null && chatThreadRange !== null && chatThreads.length > 0;
  const open = showWorkflows || showChatThreads;
  const range = showWorkflows
    ? slashRange
    : showChatThreads
      ? chatThreadRange
      : null;
  const suggestionCount = showWorkflows
    ? workflowSuggestions.length
    : chatThreads.length;

  function selectWorkflow(workflow: ComposerSlashWorkflow): void {
    insertWorkflow(workflow);
    onDraftChange?.();
  }

  function selectChatThread(chatThread: ComposerChatThreadSuggestion): void {
    insertChatThread(chatThread);
    onDraftChange?.();
  }

  function selectSuggestion(index: number): void {
    if (showWorkflows) {
      const workflow = workflowSuggestions[index];
      if (workflow) {
        selectWorkflow(workflow);
      }
      return;
    }
    const chatThread = chatThreads[index];
    if (chatThread) {
      selectChatThread(chatThread);
    }
  }

  function scrollSuggestionIntoView(index: number): void {
    if (showWorkflows) {
      scrollSlashWorkflowIntoView(workflowSuggestions[index]);
      return;
    }
    scrollChatThreadSuggestionIntoView(chatThreads[index]);
  }

  function handleKeyDown(event: KeyboardEvent): boolean {
    return handleComposerKeyDownCapture(event, {
      composer,
      suggestionCount,
      selectedSuggestionIndex: selectedIndex,
      showSuggestionMenu: open,
      setSelectedSuggestionIndex: setSelectedIndex,
      closeSuggestionMenu: close,
      selectSuggestion,
      scrollSuggestionIntoView,
      onKeyDown,
    });
  }

  return {
    open,
    range,
    selectedIndex,
    close,
    workflowNames: workflows.map((workflow) => {
      return workflow.name;
    }),
    workflows: workflowSuggestions,
    workflowQuery: slashRange?.query ?? "",
    workflowsLoading: workflowsLoadable.state === "loading",
    showWorkflows,
    chatThreads,
    showChatThreads,
    selectWorkflow,
    selectChatThread,
    handleKeyDown,
  };
}

export function TiptapWorkflowComposer({
  composer,
  onDraftChange,
  sending,
  autoFocus,
  onKeyDown,
  onPaste,
  singleLineOnMobile,
}: TiptapWorkflowComposerProps) {
  const suggestionMenu = useComposerSuggestionMenu({
    composer,
    onDraftChange,
    onKeyDown,
  });
  const setWorkflowNames = useSet(composer.setWorkflowNames$);
  const setEventHandlers = useSet(composer.setEventHandlers$);
  const insertPromptMarkdown = useSet(composer.insertPromptMarkdown$);
  const containerRefSignal = singleLineOnMobile
    ? composer.setCompactContainerRef$
    : autoFocus
      ? composer.setAutoFocusContainerRef$
      : composer.setContainerRef$;
  const setContainerRef = useSet(containerRefSignal);
  const feedbackChipsEnabled = composer.feedback.feedbackMessageCardsEnabled;

  function handlePaste(
    event: ClipboardEvent,
    currentTarget: HTMLElement,
  ): boolean {
    const clipboardData = event.clipboardData;
    const preventedBeforeHandler = event.defaultPrevented;
    onPaste({
      clipboardData,
      currentTarget,
      preventDefault: () => {
        event.preventDefault();
      },
    });
    if (!preventedBeforeHandler && event.defaultPrevented) {
      return true;
    }
    const plainText =
      clipboardData?.getData("text/plain") || clipboardData?.getData("text");
    if (plainText) {
      event.preventDefault();
      insertPromptMarkdown(plainText);
      return true;
    }
    return event.defaultPrevented;
  }

  return (
    <Popover
      open={suggestionMenu.open}
      onOpenChange={(open) => {
        if (!open) {
          suggestionMenu.close();
        }
      }}
    >
      <ComposerSuggestionCaretAnchor
        editor={composer.editor}
        range={suggestionMenu.range}
      />
      <span
        hidden
        ref={(element) => {
          if (element) {
            setWorkflowNames(suggestionMenu.workflowNames);
            setEventHandlers({
              onInput: () => {
                onDraftChange?.();
              },
              onKeyDown: suggestionMenu.handleKeyDown,
              onPaste: handlePaste,
            });
          }
        }}
      />
      <div
        className={`relative ${singleLineOnMobile ? "min-h-[44px] md:min-h-[96px]" : "min-h-[96px]"}`}
      >
        {feedbackChipsEnabled ? (
          <FeedbackChipStrip
            composer={composer}
            onDraftChange={onDraftChange}
          />
        ) : null}
        <WorkflowComposerPlaceholder composer={composer} sending={sending} />
        <div ref={setContainerRef} />
      </div>
      {suggestionMenu.showWorkflows && (
        <SlashWorkflowMenu
          workflows={suggestionMenu.workflows}
          query={suggestionMenu.workflowQuery}
          loading={suggestionMenu.workflowsLoading}
          selectedIndex={suggestionMenu.selectedIndex}
          showWorkflowsPageLink
          onSelect={suggestionMenu.selectWorkflow}
        />
      )}
      {suggestionMenu.showChatThreads && (
        <ChatThreadSuggestionMenu
          chatThreads={suggestionMenu.chatThreads}
          selectedIndex={suggestionMenu.selectedIndex}
          onSelect={suggestionMenu.selectChatThread}
        />
      )}
    </Popover>
  );
}
