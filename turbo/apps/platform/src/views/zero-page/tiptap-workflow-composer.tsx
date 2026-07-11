// TipTap-based chat composer input. Workflow mentions are colored with ProseMirror
// inline decorations rather than a transparent-textarea + colored overlay, so the
// color lives in the same layer as the text and moves/scrolls with it — there is
// no second layer to keep aligned when the input scrolls (issue #17539).
import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { useEditor, EditorContent } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Extension, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Popover, PopoverAnchor, type KeyboardEventLike } from "@vm0/ui";
import { currentChatAgentRecordId$ } from "../../signals/agent-chat.ts";
import { composerWorkflows$ } from "../../signals/workflows-page/workflows-signals.ts";
import type { DraftInputSyncTarget } from "../../signals/zero-page/chat-draft.ts";
import {
  syncTiptapWorkflowComposerEditor$,
  valueToWorkflowComposerDoc,
  workflowComposerDocToString,
  type TiptapWorkflowComposerEditorSyncArgs,
  type WorkflowHighlightStorage,
} from "../../signals/zero-page/tiptap-workflow-composer.ts";
import {
  slashWorkflowCaretIndex$,
  setSlashWorkflowCaretIndex$,
  slashWorkflowEditorFocused$,
  setSlashWorkflowEditorFocused$,
  selectedSlashWorkflowIndex$,
  setSelectedSlashWorkflowIndex$,
} from "../../signals/zero-page/zero-chat-composer.ts";
import {
  buildComposerSlashWorkflows,
  findActiveSlashWorkflowRange,
  matchesWorkflowQuery,
  scrollSlashWorkflowIntoView,
  workflowTokenPattern,
  SlashWorkflowMenu,
  type ComposerSlashWorkflow,
  type SlashWorkflowRange,
} from "./slash-workflow.tsx";
import type { ComposerPasteEvent } from "./composer-input-types.ts";

// Match the textarea metrics so swapping inputs is visually seamless. The editor
// element itself scrolls (single layer), so there is no overlay to sync. The
// resting min-height is applied separately (see editorContentClass) so the
// editor can rest at a single line on mobile.
const EDITOR_CONTENT_CLASS =
  "w-full max-h-[200px] overflow-y-auto whitespace-pre-wrap " +
  "break-words px-4 pt-4 pb-0 text-[0.9375rem] leading-6 text-foreground " +
  "caret-foreground outline-none focus:outline-none [&_p]:m-0 " +
  "selection:bg-primary/20";

// Resting height: a single line on mobile (below the md breakpoint) for chat
// thread composers, otherwise the three-line desktop height on every viewport.
// This mirrors the legacy textarea metrics in zero-chat-composer.tsx.
function editorContentClass(singleLineOnMobile: boolean): string {
  return singleLineOnMobile
    ? `${EDITOR_CONTENT_CLASS} min-h-[44px] md:min-h-[96px]`
    : `${EDITOR_CONTENT_CLASS} min-h-[96px]`;
}

const WORKFLOW_HIGHLIGHT_CLASS = "text-primary";

// Caret position as an offset into the serialized string, so the existing
// string-based slash-range detection can be reused unchanged.
function caretStringIndex(editor: Editor): number {
  const head = editor.state.selection.head;
  return editor.state.doc.textBetween(0, head, "\n", (leafNode) => {
    return leafNode.type.name === "hardBreak" ? "\n" : "";
  }).length;
}

function buildWorkflowDecorations(
  doc: ProseMirrorNode,
  workflowNames: readonly string[],
): DecorationSet {
  const pattern = workflowTokenPattern(workflowNames);
  if (!pattern) {
    return DecorationSet.empty;
  }
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    const text = node.text;
    if (!node.isText || !text) {
      return;
    }
    for (const match of text.matchAll(pattern)) {
      const start = pos + (match.index ?? 0);
      decorations.push(
        Decoration.inline(start, start + match[0].length, {
          class: WORKFLOW_HIGHLIGHT_CLASS,
        }),
      );
    }
  });
  return DecorationSet.create(doc, decorations);
}

// Colors `/workflow` tokens via inline decorations. The workflow list is read from
// mutable storage (kept current by the component) so the editor never has to be
// rebuilt when the list loads or changes.
const WorkflowHighlight = Extension.create<
  { workflowNames: readonly string[] },
  WorkflowHighlightStorage
>({
  name: "workflowHighlight",
  addOptions() {
    return { workflowNames: [] };
  },
  addStorage() {
    return { workflowNames: this.options.workflowNames };
  },
  addProseMirrorPlugins() {
    const storage = this.storage;
    return [
      new Plugin({
        key: new PluginKey("workflowHighlight"),
        props: {
          decorations(state: EditorState) {
            return buildWorkflowDecorations(state.doc, storage.workflowNames);
          },
        },
      }),
    ];
  },
});

const STARTER_KIT = StarterKit.configure({
  bold: false,
  italic: false,
  strike: false,
  code: false,
  codeBlock: false,
  heading: false,
  bulletList: false,
  orderedList: false,
  listItem: false,
  blockquote: false,
  horizontalRule: false,
  link: false,
  underline: false,
  trailingNode: false,
});

function isIOS(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isMacKeyboard(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
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
    const previousBreak = beforeCaret.lastIndexOf("\n");
    return $head.start() + previousBreak + 1;
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

function insertPlainTextLineBreak(
  editor: Editor,
  event: KeyboardEvent,
): boolean {
  if (
    event.key !== "Enter" ||
    !event.shiftKey ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  ) {
    return false;
  }

  event.preventDefault();
  return editor.commands.splitBlock();
}

// Replace the active `/query` text with the chosen token (reusing the space that
// already follows the query, or appending one). The caret is moved past that
// space so the inserted `/workflow` reads as a finished token: typing the next word
// can't merge into it, and — since menu visibility is a pure function of the
// caret position — `beforeCaret` no longer ends in a live `/token`, so the menu
// closes. Without this, selecting a workflow when text already follows the query
// left the caret between the token and its space, keeping the menu open. The
// decoration plugin colors the token automatically.
function insertWorkflowToken(
  editor: Editor,
  slashRange: SlashWorkflowRange,
  input: string,
  workflow: ComposerSlashWorkflow,
): void {
  const head = editor.state.selection.head;
  const span = slashRange.end - slashRange.start;
  const from = head - span;
  const token = `/${workflow.name}`;
  const suffix = input.slice(slashRange.end).startsWith(" ") ? "" : " ";
  editor
    .chain()
    .focus()
    .insertContentAt({ from, to: head }, [
      { type: "text", text: `${token}${suffix}` },
    ])
    .setTextSelection(from + token.length + 1)
    .run();
}

// Viewport position of the slash that started the active query, used to place the
// suggestion menu at the `/` the user typed instead of a fixed corner. The slash
// and caret sit on the same line (the range regex never spans a newline), so their
// distance in string offsets equals their distance in ProseMirror positions.
interface SlashCaretPosition {
  readonly left: number;
  readonly top: number;
  readonly height: number;
}

interface SlashCaretVirtualElement {
  readonly contextElement: HTMLElement;
  getBoundingClientRect(): DOMRect;
}

interface SlashCaretVirtualRef {
  current: SlashCaretVirtualElement;
}

function slashCaretPosition(
  editor: Editor,
  slashRange: SlashWorkflowRange,
): SlashCaretPosition {
  const slashPos = Math.max(
    editor.state.selection.head - (slashRange.end - slashRange.start),
    0,
  );
  const coords = editor.view.coordsAtPos(slashPos);
  return {
    left: coords.left,
    top: coords.top,
    height: coords.bottom - coords.top,
  };
}

function slashCaretRect(caret: SlashCaretPosition): DOMRect {
  // coordsAtPos already returns viewport coordinates. Radix uses Floating UI's
  // fixed strategy, which applies WebKit's visual-viewport offset itself when
  // the virtual element has a contextElement. Adding it here as well moves the
  // anchor twice when the iOS keyboard is open.
  return new DOMRect(caret.left, caret.top, 0, caret.height);
}

function slashCaretVirtualRef(
  editor: Editor | null,
  slashRange: SlashWorkflowRange | null,
): SlashCaretVirtualRef | null {
  if (!editor || !slashRange) {
    return null;
  }

  return {
    current: {
      contextElement: editor.view.dom,
      getBoundingClientRect() {
        return slashCaretRect(slashCaretPosition(editor, slashRange));
      },
    },
  };
}

// Virtual Popover anchor pinned to the active slash so the suggestion menu opens
// at the `/` the user typed. Reading the rect lazily lets Floating UI remeasure
// after mobile visual viewport changes without translating through a fixed DOM node.
function SlashCaretAnchor({
  editor,
  slashRange,
}: {
  readonly editor: Editor | null;
  readonly slashRange: SlashWorkflowRange | null;
}) {
  const virtualRef = slashCaretVirtualRef(editor, slashRange);
  return virtualRef ? <PopoverAnchor virtualRef={virtualRef} /> : null;
}

function handleSlashPopoverOpenChange(
  open: boolean,
  setCaretIndex: (index: number) => void,
): void {
  if (!open) {
    setCaretIndex(-1);
  }
}

interface SlashMenuKeyContext {
  readonly suggestions: readonly ComposerSlashWorkflow[];
  readonly selectedIndex: number;
  readonly setSelectedIndex: (index: number) => void;
  readonly setCaretIndex: (index: number) => void;
  readonly onInsert: (workflow: ComposerSlashWorkflow) => void;
}

// Drives the suggestion menu from the keyboard. Returns true when it consumes the
// event so the editor can stop handling that keystroke.
function handleSlashMenuKey(
  event: KeyboardEvent,
  ctx: SlashMenuKeyContext,
): boolean {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    const next = Math.min(
      ctx.selectedIndex + 1,
      Math.max(ctx.suggestions.length - 1, 0),
    );
    ctx.setSelectedIndex(next);
    scrollSlashWorkflowIntoView(ctx.suggestions[next]);
    return true;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    const next = Math.max(ctx.selectedIndex - 1, 0);
    ctx.setSelectedIndex(next);
    scrollSlashWorkflowIntoView(ctx.suggestions[next]);
    return true;
  }
  if ((event.key === "Enter" || event.key === "Tab") && ctx.suggestions[0]) {
    event.preventDefault();
    const workflow =
      ctx.suggestions[Math.min(ctx.selectedIndex, ctx.suggestions.length - 1)];
    if (workflow) {
      ctx.onInsert(workflow);
    }
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    ctx.setCaretIndex(-1);
    return true;
  }
  return false;
}

interface EditorOptionsParams {
  readonly input: string;
  readonly workflowNames: readonly string[];
  readonly autoFocus: boolean | undefined;
  readonly singleLineOnMobile: boolean;
  readonly onInputChange: (value: string) => void;
  readonly onPaste: (event: ComposerPasteEvent) => void;
  readonly setInputRef: ((el: HTMLElement | null) => void) | undefined;
  readonly setInputSyncTarget: (target: DraftInputSyncTarget | null) => void;
  readonly syncEditorState: (
    args: TiptapWorkflowComposerEditorSyncArgs,
  ) => void;
  readonly setSelectedWorkflowIndex: (index: number) => void;
  readonly setCaretIndex: (index: number) => void;
  readonly setEditorFocused: (focused: boolean) => void;
  readonly onEditorKeyDown: (event: KeyboardEvent) => boolean;
}

// Built fresh each render; useEditor applies it via setOptions so the handlers
// always close over the latest props/state (no refs needed).
function buildEditorOptions(
  params: EditorOptionsParams,
): Parameters<typeof useEditor>[0] {
  return {
    extensions: [
      STARTER_KIT,
      WorkflowHighlight.configure({ workflowNames: params.workflowNames }),
    ],
    content: valueToWorkflowComposerDoc(params.input),
    autofocus: params.autoFocus && !isIOS() ? "end" : false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: editorContentClass(params.singleLineOnMobile) },
      handleKeyDown: (_view, event) => {
        return params.onEditorKeyDown(event);
      },
      handlePaste: (view, event) => {
        params.onPaste({
          clipboardData: event.clipboardData,
          currentTarget: view.dom,
          preventDefault: () => {
            event.preventDefault();
          },
        });
        return event.defaultPrevented;
      },
    },
    onUpdate: ({ editor }) => {
      params.syncEditorState({ editor, workflowNames: params.workflowNames });
      const value = workflowComposerDocToString(editor);
      if (value !== params.input) {
        params.onInputChange(value);
      }
      params.setSelectedWorkflowIndex(0);
      params.setCaretIndex(caretStringIndex(editor));
    },
    onSelectionUpdate: ({ editor }) => {
      params.syncEditorState({ editor, workflowNames: params.workflowNames });
      params.setCaretIndex(caretStringIndex(editor));
    },
    onFocus: ({ editor }) => {
      params.setEditorFocused(true);
      params.setCaretIndex(caretStringIndex(editor));
    },
    onBlur: () => {
      params.setEditorFocused(false);
    },
    onCreate: ({ editor }) => {
      params.syncEditorState({
        editor,
        workflowNames: params.workflowNames,
        input: params.input,
      });
      params.setInputSyncTarget({
        syncInput: (input) => {
          params.syncEditorState({ editor, input });
        },
      });
      params.setInputRef?.(editor.view.dom);
    },
    onDestroy: () => {
      params.setInputSyncTarget(null);
      params.setInputRef?.(null);
      params.setEditorFocused(false);
    },
  };
}

interface TiptapWorkflowComposerProps {
  readonly input: string;
  readonly onInputChange: (value: string) => void;
  readonly onDraftChange: (() => void) | undefined;
  readonly sending: boolean | undefined;
  readonly autoFocus: boolean | undefined;
  readonly setInputRef: ((el: HTMLElement | null) => void) | undefined;
  readonly onKeyDown: (event: KeyboardEventLike) => void;
  readonly onPaste: (event: ComposerPasteEvent) => void;
  readonly setInputSyncTarget: (target: DraftInputSyncTarget | null) => void;
  readonly singleLineOnMobile: boolean;
}

function workflowComposerPlaceholder(sending: boolean | undefined): string {
  return sending
    ? "Type your next message…"
    : "Ask me to automate workflows, manage tasks...";
}

function composerWorkflowNames(
  workflows: readonly ComposerSlashWorkflow[],
): string[] {
  return workflows.map((workflow) => {
    return workflow.name;
  });
}

function workflowSuggestionState(
  input: string,
  caretIndex: number,
  workflows: readonly ComposerSlashWorkflow[],
) {
  const slashRange = findActiveSlashWorkflowRange(input, caretIndex);
  const suggestions = slashRange
    ? workflows.filter((workflow) => {
        return matchesWorkflowQuery(workflow, slashRange.query);
      })
    : [];
  return { slashRange, suggestions };
}

export function TiptapWorkflowComposer({
  input,
  onInputChange,
  onDraftChange,
  sending,
  autoFocus,
  setInputRef,
  onKeyDown,
  onPaste,
  setInputSyncTarget,
  singleLineOnMobile,
}: TiptapWorkflowComposerProps) {
  const caretIndex = useGet(slashWorkflowCaretIndex$);
  const setCaretIndex = useSet(setSlashWorkflowCaretIndex$);
  const editorFocused = useGet(slashWorkflowEditorFocused$);
  const setEditorFocused = useSet(setSlashWorkflowEditorFocused$);
  const selectedWorkflowIndex = useGet(selectedSlashWorkflowIndex$);
  const setSelectedWorkflowIndex = useSet(setSelectedSlashWorkflowIndex$);
  const syncEditorState = useSet(syncTiptapWorkflowComposerEditor$);
  const currentAgentId = useLastResolved(currentChatAgentRecordId$);
  const composerWorkflowsLoadable = useLastLoadable(composerWorkflows$);
  const composerWorkflowsData =
    composerWorkflowsLoadable.state === "hasData"
      ? composerWorkflowsLoadable.data
      : [];
  const composerWorkflows = buildComposerSlashWorkflows({
    agentId: currentAgentId,
    workflows: composerWorkflowsData,
  });
  const workflowNames = composerWorkflowNames(composerWorkflows);

  const { slashRange, suggestions } = workflowSuggestionState(
    input,
    caretIndex,
    composerWorkflows,
  );
  const isLoadingOrgWorkflows = composerWorkflowsLoadable.state === "loading";
  const showSlashWorkflowMenu = slashRange !== null && editorFocused;
  const editor = useEditor(
    buildEditorOptions({
      input,
      workflowNames,
      autoFocus,
      singleLineOnMobile,
      onInputChange,
      onPaste,
      setInputRef,
      setInputSyncTarget,
      syncEditorState,
      setSelectedWorkflowIndex,
      setCaretIndex,
      setEditorFocused,
      onEditorKeyDown: handleEditorKeyDown,
    }),
  );

  function insertWorkflow(workflow: ComposerSlashWorkflow): void {
    if (!editor || !slashRange) {
      return;
    }
    insertWorkflowToken(editor, slashRange, input, workflow);
    onDraftChange?.();
  }

  function handleEditorKeyDown(event: KeyboardEvent): boolean {
    // In the chat composer, Enter can be send, so Shift+Enter is the user's
    // plain-text newline. Keep it as a normal paragraph split rather than a
    // ProseMirror hardBreak so line navigation stays textarea-like.
    if (insertPlainTextLineBreak(editor, event)) {
      return true;
    }

    const lineNavigationPos = resolveMacControlLineNavigation(editor, event);
    if (lineNavigationPos !== null) {
      event.preventDefault();
      editor.commands.setTextSelection(lineNavigationPos);
      return true;
    }

    if (
      showSlashWorkflowMenu &&
      handleSlashMenuKey(event, {
        suggestions,
        selectedIndex: selectedWorkflowIndex,
        setSelectedIndex: setSelectedWorkflowIndex,
        setCaretIndex,
        onInsert: insertWorkflow,
      })
    ) {
      return true;
    }
    // Defer to the parent for send / global shortcuts. Sidebar shortcuts such
    // as Cmd+B are handled there before ProseMirror gets a chance to consume
    // the keystroke. If the parent consumes the event (e.g. Enter-to-send) it
    // calls preventDefault; otherwise the editor handles the keystroke (e.g.
    // Shift+Enter or mobile Enter inserts a newline).
    onKeyDown(event);
    return event.defaultPrevented;
  }

  return (
    // The controlled Radix Popover follows a virtual anchor at the typed slash.
    // Composer focus, Escape, and typing determine its visibility.
    <Popover
      open={showSlashWorkflowMenu}
      onOpenChange={(open) => {
        handleSlashPopoverOpenChange(open, setCaretIndex);
      }}
    >
      <SlashCaretAnchor editor={editor} slashRange={slashRange} />
      <div
        className={`relative ${singleLineOnMobile ? "min-h-[44px] md:min-h-[96px]" : "min-h-[96px]"}`}
      >
        {input === "" && (
          <div
            className="pointer-events-none absolute left-0 top-0 px-4 pt-4 text-[0.9375rem] leading-6 text-muted-foreground/40"
            aria-hidden="true"
          >
            {workflowComposerPlaceholder(sending)}
          </div>
        )}
        <EditorContent
          editor={editor}
          aria-label="Message"
          placeholder={workflowComposerPlaceholder(sending)}
        />
      </div>
      {showSlashWorkflowMenu && (
        <SlashWorkflowMenu
          workflows={suggestions}
          loading={isLoadingOrgWorkflows}
          selectedIndex={selectedWorkflowIndex}
          showWorkflowsPageLink
          onSelect={(workflow) => {
            insertWorkflow(workflow);
          }}
        />
      )}
    </Popover>
  );
}
