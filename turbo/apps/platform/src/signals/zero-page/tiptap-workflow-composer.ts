import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { Editor, Extension, type JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { StarterKit } from "@tiptap/starter-kit";
import { onRef } from "../utils.ts";
import type { DraftSignals } from "./chat-draft.ts";
import {
  findActiveChatThreadSuggestionRange,
  type ChatThreadSuggestionRange,
  type ComposerChatThreadSuggestion,
} from "./chat-thread-suggestion-domain.ts";
import {
  createComposerChatThreadSuggestions,
  type ComposerChatThreadSuggestionResult,
} from "./composer-chat-thread-suggestions.ts";
import {
  findActiveSlashWorkflowRange,
  workflowTokenPattern,
  type ComposerSlashWorkflow,
  type SlashWorkflowRange,
} from "./workflow-composer-domain.ts";

const EDITOR_CONTENT_CLASS =
  "w-full max-h-[200px] overflow-y-auto whitespace-pre-wrap " +
  "break-words px-4 pt-4 pb-0 text-[0.9375rem] leading-6 text-foreground " +
  "caret-foreground outline-none focus:outline-none [&_p]:m-0 " +
  "selection:bg-primary/20";

function editorContentClass(singleLineOnMobile: boolean): string {
  return singleLineOnMobile
    ? `${EDITOR_CONTENT_CLASS} min-h-[44px] md:min-h-[96px]`
    : `${EDITOR_CONTENT_CLASS} min-h-[96px]`;
}

const WORKFLOW_HIGHLIGHT_CLASS = "text-primary";
const COMPOSER_PLACEHOLDER = "Ask me to automate workflows, manage tasks...";

function isIOS(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

interface WorkflowHighlightStorage {
  workflowNames: readonly string[];
}

export interface WorkflowComposerSignals {
  readonly editor: Editor;
  readonly setContainerRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly setAutoFocusContainerRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly setCompactContainerRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly focus$: Command<void, []>;
  readonly hasInput$: Computed<boolean>;
  readonly activeSlashRange$: Computed<SlashWorkflowRange | null>;
  readonly activeChatThreadSuggestionRange$: Computed<ChatThreadSuggestionRange | null>;
  readonly chatThreadSuggestions$: Computed<
    Promise<ComposerChatThreadSuggestionResult>
  >;
  readonly selectedSuggestionIndex$: Computed<number>;
  readonly setSelectedSuggestionIndex$: Command<void, [number]>;
  readonly closeSuggestionMenu$: Command<void, []>;
  readonly setWorkflowNames$: Command<void, [readonly string[]]>;
  readonly insertWorkflow$: Command<void, [ComposerSlashWorkflow]>;
  readonly insertChatThread$: Command<void, [ComposerChatThreadSuggestion]>;
  readonly setEventHandlers$: Command<void, [WorkflowComposerEventHandlers]>;
}

export interface WorkflowComposerEventHandlers {
  readonly onInput: () => void;
  readonly onKeyDown: (event: KeyboardEvent) => boolean;
  readonly onPaste: (
    event: ClipboardEvent,
    currentTarget: HTMLElement,
  ) => boolean;
}

function valueToWorkflowComposerDoc(value: string): JSONContent {
  const content: JSONContent[] = value.split("\n").map((line) => {
    return line.length > 0
      ? { type: "paragraph", content: [{ type: "text", text: line }] }
      : { type: "paragraph" };
  });
  return { type: "doc", content };
}

function workflowComposerDocToString(editor: Editor): string {
  return editor.getText({
    blockSeparator: "\n",
    textSerializers: {
      hardBreak: () => {
        return "\n";
      },
    },
  });
}

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

function isWorkflowHighlightStorage(
  value: unknown,
): value is WorkflowHighlightStorage {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray(Reflect.get(value, "workflowNames"))
  );
}

function workflowHighlightStorage(editor: Editor): WorkflowHighlightStorage {
  const storage: unknown = Reflect.get(editor.storage, "workflowHighlight");
  if (!isWorkflowHighlightStorage(storage)) {
    throw new Error("Workflow highlight storage is unavailable");
  }
  return storage;
}

interface WorkflowComposerRuntime {
  update(editor: Editor): void;
  selectionUpdate(editor: Editor): void;
  focus(editor: Editor): void;
  blur(): void;
  input(): void;
  keyDown(event: KeyboardEvent): boolean;
  paste(event: ClipboardEvent, currentTarget: HTMLElement): boolean;
}

function createWorkflowEditor(runtime: WorkflowComposerRuntime): Editor {
  return new Editor({
    element: null,
    extensions: [STARTER_KIT, WorkflowHighlight],
    content: valueToWorkflowComposerDoc(""),
    editorProps: {
      attributes: {
        "aria-label": "Message",
        placeholder: COMPOSER_PLACEHOLDER,
        tabindex: "0",
        class: EDITOR_CONTENT_CLASS,
      },
      handlePaste: (_view, event) => {
        return runtime.paste(event, _view.dom);
      },
      handleKeyDown: (_view, event) => {
        return runtime.keyDown(event);
      },
    },
    onUpdate: ({ editor }) => {
      runtime.update(editor);
    },
    onSelectionUpdate: ({ editor }) => {
      runtime.selectionUpdate(editor);
    },
    onFocus: ({ editor }) => {
      runtime.focus(editor);
    },
    onBlur: () => {
      runtime.blur();
    },
  });
}

function createMountEditorCommand({
  editor,
  draft,
  runtime,
  caretIndex$,
  editorFocusedState$,
  selectedSuggestionIndexState$,
  autoFocus,
  singleLineOnMobile,
}: {
  editor: Editor;
  draft: DraftSignals;
  runtime: WorkflowComposerRuntime;
  caretIndex$: State<number>;
  editorFocusedState$: State<boolean>;
  selectedSuggestionIndexState$: State<number>;
  autoFocus: boolean;
  singleLineOnMobile: boolean;
}) {
  return onRef(
    command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
      runtime.update = (updatedEditor) => {
        set(draft.setInput$, workflowComposerDocToString(updatedEditor));
        set(selectedSuggestionIndexState$, 0);
        set(caretIndex$, caretStringIndex(updatedEditor));
        runtime.input();
      };
      runtime.selectionUpdate = (updatedEditor) => {
        set(caretIndex$, caretStringIndex(updatedEditor));
      };
      runtime.focus = (focusedEditor) => {
        set(editorFocusedState$, true);
        set(caretIndex$, caretStringIndex(focusedEditor));
      };
      runtime.blur = () => {
        set(editorFocusedState$, false);
      };
      editor.setOptions({
        editorProps: {
          attributes: {
            "aria-label": "Message",
            placeholder: COMPOSER_PLACEHOLDER,
            tabindex: "0",
            class: editorContentClass(singleLineOnMobile),
          },
          handlePaste: (_view, event) => {
            return runtime.paste(event, _view.dom);
          },
          handleKeyDown: (_view, event) => {
            return runtime.keyDown(event);
          },
        },
      });
      const input = get(draft.input$);
      if (workflowComposerDocToString(editor) !== input) {
        editor.commands.setContent(valueToWorkflowComposerDoc(input), {
          emitUpdate: false,
        });
      }
      editor.mount(element);
      set(draft.setInputSyncTarget$, {
        syncInput(value: string) {
          if (workflowComposerDocToString(editor) !== value) {
            editor.commands.setContent(valueToWorkflowComposerDoc(value), {
              emitUpdate: false,
            });
          }
        },
      });
      if (autoFocus && !isIOS()) {
        editor.commands.focus("end");
      }
      signal.addEventListener("abort", () => {
        runtime.update = () => {};
        runtime.selectionUpdate = () => {};
        runtime.focus = () => {};
        runtime.blur = () => {};
        runtime.input = () => {};
        runtime.keyDown = () => {
          return false;
        };
        runtime.paste = () => {
          return false;
        };
        set(draft.setInputSyncTarget$, null);
        set(editorFocusedState$, false);
        editor.unmount();
      });
    }),
  );
}

function createInsertWorkflowCommand(
  editor: Editor,
  draft: DraftSignals,
  activeSlashRange$: Computed<SlashWorkflowRange | null>,
) {
  return command(({ get }, workflow: ComposerSlashWorkflow) => {
    const slashRange = get(activeSlashRange$);
    if (!slashRange) {
      return;
    }
    const input = get(draft.input$);
    const head = editor.state.selection.head;
    const from = head - (slashRange.end - slashRange.start);
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
  });
}

function createInsertChatThreadCommand(
  editor: Editor,
  draft: DraftSignals,
  activeRange$: Computed<ChatThreadSuggestionRange | null>,
) {
  return command(({ get }, chatThread: ComposerChatThreadSuggestion) => {
    const range = get(activeRange$);
    if (!range) {
      return;
    }
    const input = get(draft.input$);
    const head = editor.state.selection.head;
    const from = head - (range.end - range.start);
    const token = `/chats/${chatThread.id}`;
    const suffix = input.slice(range.end).startsWith(" ") ? "" : " ";
    editor
      .chain()
      .focus()
      .insertContentAt({ from, to: head }, [
        { type: "text", text: `${token}${suffix}` },
      ])
      .setTextSelection(from + token.length + 1)
      .run();
  });
}

export function createWorkflowComposerSignals(
  draft: DraftSignals,
): WorkflowComposerSignals {
  const caretIndex$ = state(-1);
  const editorFocusedState$ = state(false);
  const selectedSuggestionIndexState$ = state(0);
  const runtime: WorkflowComposerRuntime = {
    update(_editor: Editor): void {},
    selectionUpdate(_editor: Editor): void {},
    focus(_editor: Editor): void {},
    blur(): void {},
    input(): void {},
    keyDown(_event: KeyboardEvent): boolean {
      return false;
    },
    paste: (_event: ClipboardEvent, _currentTarget: HTMLElement) => {
      return false;
    },
  };

  const editor = createWorkflowEditor(runtime);

  const selectedSuggestionIndex$ = computed((get) => {
    return get(selectedSuggestionIndexState$);
  });
  const activeSlashRange$ = computed((get) => {
    if (!get(editorFocusedState$)) {
      return null;
    }
    return findActiveSlashWorkflowRange(get(draft.input$), get(caretIndex$));
  });
  const activeChatThreadSuggestionRange$ = computed((get) => {
    if (!get(editorFocusedState$)) {
      return null;
    }
    return findActiveChatThreadSuggestionRange(
      get(draft.input$),
      get(caretIndex$),
    );
  });
  const chatThreadSuggestions$ = createComposerChatThreadSuggestions(
    activeChatThreadSuggestionRange$,
  );
  const setSelectedSuggestionIndex$ = command(({ set }, index: number) => {
    set(selectedSuggestionIndexState$, index);
  });
  const closeSuggestionMenu$ = command(({ set }) => {
    set(caretIndex$, -1);
  });
  const focus$ = command(() => {
    editor.commands.focus("end");
  });
  const setWorkflowNames$ = command((_context, names: readonly string[]) => {
    workflowHighlightStorage(editor).workflowNames = names;
    if (editor.isInitialized) {
      editor.view.dispatch(editor.state.tr);
    }
  });
  const setEventHandlers$ = command(
    (_context, handlers: WorkflowComposerEventHandlers) => {
      runtime.input = handlers.onInput;
      runtime.keyDown = handlers.onKeyDown;
      runtime.paste = handlers.onPaste;
    },
  );
  const mountEditor = (autoFocus: boolean, singleLineOnMobile: boolean) => {
    return createMountEditorCommand({
      editor,
      draft,
      runtime,
      caretIndex$,
      editorFocusedState$,
      selectedSuggestionIndexState$,
      autoFocus,
      singleLineOnMobile,
    });
  };
  const insertWorkflow$ = createInsertWorkflowCommand(
    editor,
    draft,
    activeSlashRange$,
  );
  const insertChatThread$ = createInsertChatThreadCommand(
    editor,
    draft,
    activeChatThreadSuggestionRange$,
  );

  return {
    editor,
    setContainerRef$: mountEditor(false, false),
    setAutoFocusContainerRef$: mountEditor(true, false),
    setCompactContainerRef$: mountEditor(false, true),
    focus$,
    hasInput$: draft.hasInput$,
    activeSlashRange$,
    activeChatThreadSuggestionRange$,
    chatThreadSuggestions$,
    selectedSuggestionIndex$,
    setSelectedSuggestionIndex$,
    closeSuggestionMenu$,
    setWorkflowNames$,
    insertWorkflow$,
    insertChatThread$,
    setEventHandlers$,
  };
}
