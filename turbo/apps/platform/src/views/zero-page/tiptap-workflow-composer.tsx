import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import type { Editor, NodeViewRenderer } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";
import { createRoot } from "react-dom/client";
import { IconQuote, IconX } from "@tabler/icons-react";
import { cn, Popover, PopoverAnchor, type KeyboardEventLike } from "@vm0/ui";
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
import type { FeedbackItem } from "../../signals/zero-page/chat-feedback.ts";

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
  feedbackActive,
}: {
  composer: WorkflowComposerSignals;
  sending: boolean | undefined;
  feedbackActive: boolean;
}) {
  const hasInput = useGet(composer.hasInput$);
  if (feedbackActive || hasInput) {
    return null;
  }
  return (
    <div
      className="pointer-events-none absolute left-0 top-0 px-4 pt-4 text-[0.9375rem] leading-6 text-muted-foreground/40"
      aria-hidden="true"
    >
      {workflowComposerPlaceholder(sending)}
    </div>
  );
}

interface FeedbackNodeViewAttributes {
  readonly quote: string;
  readonly showDivider: boolean;
  readonly fill: boolean;
}

function feedbackNodeViewAttributes(
  node: ProseMirrorNode,
): FeedbackNodeViewAttributes {
  const quote: unknown = node.attrs.quote;
  const showDivider: unknown = node.attrs.showDivider;
  const fill: unknown = node.attrs.fill;
  if (
    typeof quote !== "string" ||
    typeof showDivider !== "boolean" ||
    typeof fill !== "boolean"
  ) {
    throw new Error("Feedback item node attributes are invalid");
  }
  return { quote, showDivider, fill };
}

function ComposerFeedbackQuote({
  quote,
  onRemove,
}: {
  readonly quote: string;
  readonly onRemove: () => void;
}) {
  return (
    <div className="flex" contentEditable={false}>
      <div className="inline-flex h-8 max-w-full items-center gap-2 rounded-lg border border-border/80 bg-background/90 pl-1.5 pr-1 text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.05)]">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted">
          <IconQuote
            size={12}
            stroke={1.5}
            className="-scale-x-100 text-muted-foreground"
          />
        </span>
        <span className="min-w-0 truncate text-xs font-medium">{quote}</span>
        <button
          type="button"
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={onRemove}
          aria-label="Remove feedback"
          title="Remove feedback"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <IconX size={14} stroke={1.8} />
        </button>
      </div>
    </div>
  );
}

function deleteFeedbackNode(
  getPos: () => number | undefined,
  node: ProseMirrorNode,
  editor: Editor,
): void {
  const position = getPos();
  if (typeof position !== "number") {
    return;
  }
  editor.view.dispatch(
    editor.state.tr.delete(position, position + node.nodeSize),
  );
}

const feedbackItemNodeViewRenderer: NodeViewRenderer = (props) => {
  const dom = document.createElement("div");
  dom.dataset.feedbackItem = "";
  const quoteDom = document.createElement("div");
  const quoteRoot = createRoot(quoteDom);
  const noteDom = document.createElement("div");
  const placeholderDom = document.createElement("span");
  placeholderDom.className =
    "pointer-events-none absolute left-1 top-1 text-[0.9375rem] " +
    "leading-snug text-muted-foreground/40";
  placeholderDom.textContent = "What should change about this?";
  placeholderDom.setAttribute("aria-hidden", "true");
  const contentDOM = document.createElement("div");
  contentDOM.dataset.feedbackNote = "";
  contentDOM.setAttribute("role", "textbox");
  contentDOM.setAttribute("aria-label", "What should change about this?");
  contentDOM.setAttribute("aria-multiline", "true");
  noteDom.append(placeholderDom, contentDOM);
  dom.append(quoteDom, noteDom);

  let currentNode = props.node;
  function render(node: ProseMirrorNode): void {
    const { quote, showDivider, fill } = feedbackNodeViewAttributes(node);
    dom.className = cn(
      "flex flex-col gap-1.5 pb-1.5",
      showDivider && "border-t border-dashed border-border/60 pt-1.5",
    );
    noteDom.className = cn("relative", fill && "min-h-[96px]");
    placeholderDom.hidden = node.textContent.length > 0;
    contentDOM.className = cn(
      "relative w-full px-1 py-1 text-[0.9375rem] leading-snug text-foreground outline-none [&_p]:m-0",
      fill && "min-h-[96px]",
    );
    quoteRoot.render(
      <ComposerFeedbackQuote
        quote={quote}
        onRemove={() => {
          queueMicrotask(() => {
            deleteFeedbackNode(props.getPos, currentNode, props.editor);
          });
        }}
      />,
    );
  }
  render(currentNode);

  const nodeView: NodeView = {
    dom,
    contentDOM,
    update(node) {
      if (node.type !== currentNode.type) {
        return false;
      }
      currentNode = node;
      render(node);
      return true;
    },
    stopEvent(event) {
      return (
        event.target instanceof globalThis.Node &&
        quoteDom.contains(event.target)
      );
    },
    ignoreMutation(mutation) {
      return (
        mutation.type !== "selection" && !contentDOM.contains(mutation.target)
      );
    },
    destroy() {
      queueMicrotask(() => {
        quoteRoot.unmount();
      });
    },
  };
  return nodeView;
};

export interface TiptapWorkflowComposerFeedback {
  readonly items: readonly FeedbackItem[];
  readonly onItemsChange: (items: readonly FeedbackItem[]) => void;
}

export interface TiptapWorkflowComposerProps {
  readonly composer: WorkflowComposerSignals;
  readonly onDraftChange: (() => void) | undefined;
  readonly sending: boolean | undefined;
  readonly autoFocus: boolean | undefined;
  readonly onKeyDown: (event: KeyboardEventLike) => void;
  readonly onPaste: (event: ComposerPasteEvent) => void;
  readonly singleLineOnMobile: boolean;
  readonly feedback: TiptapWorkflowComposerFeedback | null;
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
  feedback,
}: TiptapWorkflowComposerProps) {
  const suggestionMenu = useComposerSuggestionMenu({
    composer,
    onDraftChange,
    onKeyDown,
  });
  const setWorkflowNames = useSet(composer.setWorkflowNames$);
  const setEventHandlers = useSet(composer.setEventHandlers$);
  const setFeedbackItems = useSet(composer.setFeedbackItems$);
  const setFeedbackNodeViewRenderer = useSet(
    composer.setFeedbackNodeViewRenderer$,
  );
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
      composer.editor.commands.insertContent(plainText);
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
            setFeedbackNodeViewRenderer(feedbackItemNodeViewRenderer);
            setFeedbackItems(feedback?.items ?? null);
            setWorkflowNames(suggestionMenu.workflowNames);
            setEventHandlers({
              onInput: () => {
                onDraftChange?.();
              },
              onFeedbackItemsChange: (items) => {
                feedback?.onItemsChange(items);
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
        <WorkflowComposerPlaceholder
          composer={composer}
          sending={sending}
          feedbackActive={feedback !== null}
        />
        <div ref={setContainerRef} />
      </div>
      {suggestionMenu.showWorkflows && (
        <SlashWorkflowMenu
          workflows={suggestionMenu.workflows}
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
