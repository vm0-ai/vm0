import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Popover, PopoverAnchor, type KeyboardEventLike } from "@vm0/ui";
import { currentChatAgentRecordId$ } from "../../signals/agent-chat.ts";
import type { WorkflowComposerSignals } from "../../signals/zero-page/tiptap-workflow-composer.ts";
import { composerWorkflows$ } from "../../signals/workflows-page/workflows-signals.ts";
import {
  buildComposerSlashWorkflows,
  matchesWorkflowQuery,
  scrollSlashWorkflowIntoView,
  SlashWorkflowMenu,
  type ComposerSlashWorkflow,
  type SlashWorkflowRange,
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

interface SlashCaretVirtualRef {
  current: {
    readonly contextElement: HTMLElement;
    getBoundingClientRect(): DOMRect;
  };
}

function slashCaretVirtualRef(
  editor: Editor,
  slashRange: SlashWorkflowRange | null,
): SlashCaretVirtualRef | null {
  if (!slashRange || !editor.isInitialized) {
    return null;
  }
  return {
    current: {
      contextElement: editor.view.dom,
      getBoundingClientRect() {
        const slashPos = Math.max(
          editor.state.selection.head - (slashRange.end - slashRange.start),
          0,
        );
        const coords = editor.view.coordsAtPos(slashPos);
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

function SlashCaretAnchor({
  editor,
  slashRange,
}: {
  readonly editor: Editor;
  readonly slashRange: SlashWorkflowRange | null;
}) {
  const virtualRef = slashCaretVirtualRef(editor, slashRange);
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
  if (hasInput) {
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
  readonly suggestions: readonly ComposerSlashWorkflow[];
  readonly selectedWorkflowIndex: number;
  readonly showSlashWorkflowMenu: boolean;
  readonly setSelectedWorkflowIndex: (index: number) => void;
  readonly closeSlashMenu: () => void;
  readonly selectWorkflow: (workflow: ComposerSlashWorkflow) => void;
  readonly onKeyDown: (event: KeyboardEventLike) => void;
}

function handleComposerKeyDownCapture(
  event: KeyboardEvent,
  context: ComposerKeyDownContext,
): boolean {
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
  if (!context.showSlashWorkflowMenu) {
    context.onKeyDown(event);
    return event.defaultPrevented;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = Math.max(
      0,
      Math.min(
        context.selectedWorkflowIndex + delta,
        Math.max(context.suggestions.length - 1, 0),
      ),
    );
    context.setSelectedWorkflowIndex(next);
    scrollSlashWorkflowIntoView(context.suggestions[next]);
    return true;
  }
  if (
    (event.key === "Enter" || event.key === "Tab") &&
    context.suggestions[0]
  ) {
    event.preventDefault();
    const workflow =
      context.suggestions[
        Math.min(context.selectedWorkflowIndex, context.suggestions.length - 1)
      ];
    if (workflow) {
      context.selectWorkflow(workflow);
    }
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    context.closeSlashMenu();
    return true;
  }
  context.onKeyDown(event);
  return event.defaultPrevented;
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
  const slashRange = useGet(composer.activeSlashRange$);
  const selectedWorkflowIndex = useGet(composer.selectedWorkflowIndex$);
  const setSelectedWorkflowIndex = useSet(composer.setSelectedWorkflowIndex$);
  const closeSlashMenu = useSet(composer.closeSlashMenu$);
  const setWorkflowNames = useSet(composer.setWorkflowNames$);
  const setEventHandlers = useSet(composer.setEventHandlers$);
  const insertWorkflow = useSet(composer.insertWorkflow$);
  const containerRefSignal = singleLineOnMobile
    ? composer.setCompactContainerRef$
    : autoFocus
      ? composer.setAutoFocusContainerRef$
      : composer.setContainerRef$;
  const setContainerRef = useSet(containerRefSignal);
  const currentAgentId = useLastResolved(currentChatAgentRecordId$);
  const workflowsLoadable = useLastLoadable(composerWorkflows$);
  const workflows = buildComposerSlashWorkflows({
    agentId: currentAgentId,
    workflows:
      workflowsLoadable.state === "hasData" ? workflowsLoadable.data : [],
  });
  const suggestions = slashRange
    ? workflows.filter((workflow) => {
        return matchesWorkflowQuery(workflow, slashRange.query);
      })
    : [];
  const showSlashWorkflowMenu = slashRange !== null;

  function selectWorkflow(workflow: ComposerSlashWorkflow): void {
    insertWorkflow(workflow);
    onDraftChange?.();
  }

  function handleKeyDown(event: KeyboardEvent): boolean {
    return handleComposerKeyDownCapture(event, {
      composer,
      suggestions,
      selectedWorkflowIndex,
      showSlashWorkflowMenu,
      setSelectedWorkflowIndex,
      closeSlashMenu,
      selectWorkflow,
      onKeyDown,
    });
  }

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

  const workflowNames = workflows.map((workflow) => {
    return workflow.name;
  });

  return (
    <Popover
      open={showSlashWorkflowMenu}
      onOpenChange={(open) => {
        if (!open) {
          closeSlashMenu();
        }
      }}
    >
      <SlashCaretAnchor editor={composer.editor} slashRange={slashRange} />
      <span
        hidden
        ref={(element) => {
          if (element) {
            setWorkflowNames(workflowNames);
            setEventHandlers({
              onInput: () => {
                onDraftChange?.();
              },
              onKeyDown: handleKeyDown,
              onPaste: handlePaste,
            });
          }
        }}
      />
      <div
        className={`relative ${singleLineOnMobile ? "min-h-[44px] md:min-h-[96px]" : "min-h-[96px]"}`}
      >
        <WorkflowComposerPlaceholder composer={composer} sending={sending} />
        <div ref={setContainerRef} />
      </div>
      {showSlashWorkflowMenu && (
        <SlashWorkflowMenu
          workflows={suggestions}
          loading={workflowsLoadable.state === "loading"}
          selectedIndex={selectedWorkflowIndex}
          showWorkflowsPageLink
          onSelect={selectWorkflow}
        />
      )}
    </Popover>
  );
}
