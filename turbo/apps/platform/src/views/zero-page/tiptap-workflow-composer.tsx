import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Popover, PopoverAnchor, type KeyboardEventLike } from "@vm0/ui";
import type { ComposerChatThreadSuggestion } from "../../signals/zero-page/chat-thread-suggestion-domain.ts";
import { composerChatThreadSuggestionsEnabled$ } from "../../signals/zero-page/composer-chat-thread-suggestions.ts";
import type { WorkflowComposerSignals } from "../../signals/zero-page/tiptap-workflow-composer.ts";
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
  const currentAgentId = useLastResolved(composer.agentId$);
  const workflowsLoadable = useLastLoadable(composer.workflows$);
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
  const hasTemplateAttachment = useGet(composer.hasTemplateAttachment$);
  const containerRefSignal = singleLineOnMobile
    ? composer.setCompactContainerRef$
    : autoFocus
      ? composer.setAutoFocusContainerRef$
      : composer.setContainerRef$;
  const setContainerRef = useSet(containerRefSignal);

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
      <div className="relative">
        <WorkflowComposerPlaceholder composer={composer} sending={sending} />
        <div
          // The template chip is 32px tall with 6px bottom spacing. Reserve
          // those 38px above the input instead of letting the chip consume it.
          className={
            hasTemplateAttachment
              ? singleLineOnMobile
                ? "min-h-[82px] md:min-h-[134px] [&_.ProseMirror]:min-h-[82px] md:[&_.ProseMirror]:min-h-[134px]"
                : "min-h-[134px] [&_.ProseMirror]:min-h-[134px]"
              : singleLineOnMobile
                ? "min-h-[44px] md:min-h-[96px]"
                : "min-h-[96px]"
          }
          ref={setContainerRef}
        />
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
