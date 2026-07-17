import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { Editor, Extension, Node, type JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type NodeView } from "@tiptap/pm/view";
import { StarterKit } from "@tiptap/starter-kit";
import { onRef } from "../utils.ts";
import type { DraftSignals } from "./chat-draft.ts";
import {
  createFeedbackSignals,
  type FeedbackItem,
  type FeedbackSignals,
} from "./chat-feedback.ts";
import {
  findActiveChatThreadSuggestionRange,
  serializeChatThreadMention,
  splitChatThreadMentionSegments,
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
import {
  createTemplatePreviewRuntime,
  type TemplatePreviewRuntime,
} from "./template-preview-runtime.ts";

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
  readonly templatePreview: TemplatePreviewRuntime;
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
  readonly feedback: FeedbackSignals;
}

export interface WorkflowComposerEventHandlers {
  readonly onInput: () => void;
  readonly onKeyDown: (event: KeyboardEvent) => boolean;
  readonly onPaste: (
    event: ClipboardEvent,
    currentTarget: HTMLElement,
  ) => boolean;
}

const FEEDBACK_ITEM_NODE_NAME = "feedbackItem";
const CHAT_THREAD_MENTION_NODE_NAME = "chatThreadMention";
const CHAT_THREAD_MENTION_CLASS =
  "rounded bg-primary/10 px-1 text-primary whitespace-nowrap";

interface ChatThreadMentionAttributes {
  readonly threadId: string;
  readonly title: string;
}

function chatThreadMentionAttributes(
  node: ProseMirrorNode,
): ChatThreadMentionAttributes {
  const threadId: unknown = node.attrs.threadId;
  const title: unknown = node.attrs.title;
  if (typeof threadId !== "string" || typeof title !== "string") {
    throw new Error("Chat thread mention node attributes are invalid");
  }
  return { threadId, title };
}

function chatThreadMentionText(node: ProseMirrorNode): string {
  const { threadId, title } = chatThreadMentionAttributes(node);
  return serializeChatThreadMention(threadId, title);
}

const ChatThreadMentionNode = Node.create({
  name: CHAT_THREAD_MENTION_NODE_NAME,
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return {
      threadId: { default: "" },
      title: { default: "" },
    };
  },
  parseHTML() {
    return [
      {
        tag: "span[data-chat-thread-mention]",
        getAttrs: (element) => {
          return {
            threadId: element.dataset.chatThreadMention ?? "",
            title: element.textContent ?? "",
          };
        },
      },
    ];
  },
  renderHTML({ node }) {
    const { threadId, title } = chatThreadMentionAttributes(node);
    return [
      "span",
      {
        "data-chat-thread-mention": threadId,
        class: CHAT_THREAD_MENTION_CLASS,
      },
      title,
    ];
  },
  renderText({ node }) {
    return chatThreadMentionText(node);
  },
});

interface FeedbackItemNodeAttributes {
  readonly feedbackId: number;
  readonly quote: string;
  readonly showDivider: boolean;
  readonly fill: boolean;
}

function feedbackItemNodeAttributes(
  node: ProseMirrorNode,
): FeedbackItemNodeAttributes {
  const feedbackId: unknown = node.attrs.feedbackId;
  const quote: unknown = node.attrs.quote;
  const showDivider: unknown = node.attrs.showDivider;
  const fill: unknown = node.attrs.fill;
  if (
    typeof feedbackId !== "number" ||
    typeof quote !== "string" ||
    typeof showDivider !== "boolean" ||
    typeof fill !== "boolean"
  ) {
    throw new Error("Feedback item node attributes are invalid");
  }
  return { feedbackId, quote, showDivider, fill };
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function createFeedbackIcon(
  size: number,
  strokeWidth: number,
  paths: readonly string[],
): SVGSVGElement {
  const icon = document.createElementNS(SVG_NAMESPACE, "svg");
  icon.setAttribute("width", String(size));
  icon.setAttribute("height", String(size));
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", String(strokeWidth));
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");
  for (const pathData of paths) {
    const path = document.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute("d", pathData);
    icon.append(path);
  }
  return icon;
}

function createFeedbackItemNodeView(
  node: ProseMirrorNode,
  removeFeedback: (id: number) => void,
): NodeView {
  const dom = document.createElement("div");
  dom.dataset.feedbackItem = "";

  const quoteDom = document.createElement("div");
  quoteDom.className = "flex";
  quoteDom.contentEditable = "false";
  const quoteChip = document.createElement("div");
  quoteChip.className =
    "inline-flex h-8 max-w-full items-center gap-2 rounded-lg border " +
    "border-border/80 bg-background/90 pl-1.5 pr-1 text-foreground " +
    "shadow-[0_1px_2px_rgba(15,23,42,0.05)]";
  const quoteIconContainer = document.createElement("span");
  quoteIconContainer.className =
    "flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted";
  const quoteIcon = createFeedbackIcon(12, 1.5, [
    "M10 11h-4a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1h3a1 1 0 0 1 1 1v6c0 2.667 -1.333 4.333 -4 5",
    "M19 11h-4a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1h3a1 1 0 0 1 1 1v6c0 2.667 -1.333 4.333 -4 5",
  ]);
  quoteIcon.setAttribute("class", "-scale-x-100 text-muted-foreground");
  quoteIconContainer.append(quoteIcon);
  const quoteText = document.createElement("span");
  quoteText.className = "min-w-0 truncate text-xs font-medium";
  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className =
    "flex h-6 w-6 shrink-0 items-center justify-center rounded-md " +
    "text-muted-foreground/70 transition-colors hover:bg-muted " +
    "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 " +
    "focus-visible:ring-ring";
  removeButton.setAttribute("aria-label", "Remove feedback");
  removeButton.title = "Remove feedback";
  removeButton.append(
    createFeedbackIcon(14, 1.8, ["M18 6l-12 12", "M6 6l12 12"]),
  );
  quoteChip.append(quoteIconContainer, quoteText, removeButton);
  quoteDom.append(quoteChip);

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

  let currentNode = node;
  function render(nextNode: ProseMirrorNode): void {
    const { quote, showDivider, fill } = feedbackItemNodeAttributes(nextNode);
    dom.className = `flex flex-col gap-1.5 pb-1.5${
      showDivider ? " border-t border-dashed border-border/60 pt-1.5" : ""
    }`;
    noteDom.className = `relative${fill ? " min-h-[96px]" : ""}`;
    placeholderDom.hidden = nextNode.textContent.length > 0;
    contentDOM.className =
      "relative w-full px-1 py-1 text-[0.9375rem] leading-snug " +
      `text-foreground outline-none [&_p]:m-0${fill ? " min-h-[96px]" : ""}`;
    quoteText.textContent = quote;
  }
  removeButton.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  removeButton.addEventListener("click", () => {
    removeFeedback(feedbackItemNodeAttributes(currentNode).feedbackId);
  });
  render(currentNode);

  return {
    dom,
    contentDOM,
    update(nextNode) {
      if (nextNode.type !== currentNode.type) {
        return false;
      }
      currentNode = nextNode;
      render(nextNode);
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
  };
}

function feedbackNoteContent(note: string): JSONContent[] {
  return note.split("\n").map((line) => {
    return line.length > 0
      ? { type: "paragraph", content: [{ type: "text", text: line }] }
      : { type: "paragraph" };
  });
}

function feedbackNoteFromNode(node: ProseMirrorNode): string {
  return node.textBetween(0, node.content.size, "\n", (leafNode) => {
    return leafNode.type.name === "hardBreak" ? "\n" : "";
  });
}

function feedbackItemsToWorkflowComposerDoc(
  editor: Editor,
  items: readonly FeedbackItem[],
): ProseMirrorNode {
  const existingNodes = new Map<number, ProseMirrorNode>();
  for (let index = 0; index < editor.state.doc.childCount; index++) {
    const node = editor.state.doc.child(index);
    if (node.type.name !== FEEDBACK_ITEM_NODE_NAME) {
      continue;
    }
    existingNodes.set(feedbackItemNodeAttributes(node).feedbackId, node);
  }
  const nodes = items.map((item, index) => {
    const existingNode = existingNodes.get(item.id);
    const canReuseContent =
      existingNode !== undefined &&
      feedbackItemNodeAttributes(existingNode).quote === item.quote &&
      feedbackNoteFromNode(existingNode) === item.note;
    const content = canReuseContent
      ? existingNode.content
      : editor.schema.nodeFromJSON({
          type: FEEDBACK_ITEM_NODE_NAME,
          content: feedbackNoteContent(item.note),
        }).content;
    return editor.schema.node(
      FEEDBACK_ITEM_NODE_NAME,
      {
        feedbackId: item.id,
        quote: item.quote,
        showDivider: index > 0,
        fill: index === items.length - 1,
      },
      content,
    );
  });
  return editor.schema.topNodeType.create(null, nodes);
}

function feedbackItemsFromWorkflowComposer(
  editor: Editor,
): readonly FeedbackItem[] {
  const items: FeedbackItem[] = [];
  for (let index = 0; index < editor.state.doc.childCount; index++) {
    const node = editor.state.doc.child(index);
    if (node.type.name !== FEEDBACK_ITEM_NODE_NAME) {
      continue;
    }
    const attributes = feedbackItemNodeAttributes(node);
    items.push({
      id: attributes.feedbackId,
      quote: attributes.quote,
      note: feedbackNoteFromNode(node),
    });
  }
  return items;
}

function valueToWorkflowComposerDoc(value: string): JSONContent {
  const content: JSONContent[] = value.split("\n").map((line) => {
    if (line.length === 0) {
      return { type: "paragraph" };
    }
    const inlineContent = splitChatThreadMentionSegments(line).map(
      (segment): JSONContent => {
        return segment.type === "text"
          ? { type: "text", text: segment.text }
          : {
              type: CHAT_THREAD_MENTION_NODE_NAME,
              attrs: { threadId: segment.threadId, title: segment.title },
            };
      },
    );
    return { type: "paragraph", content: inlineContent };
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
      [CHAT_THREAD_MENTION_NODE_NAME]: ({ node }) => {
        return chatThreadMentionText(node);
      },
    },
  });
}

function caretStringIndex(editor: Editor): number {
  const head = editor.state.selection.head;
  return editor.state.doc.textBetween(0, head, "\n", (leafNode) => {
    if (leafNode.type.name === CHAT_THREAD_MENTION_NODE_NAME) {
      return chatThreadMentionText(leafNode);
    }
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
  replaceFeedbackItems(items: readonly FeedbackItem[]): void;
  removeFeedback(id: number): void;
  keyDown(event: KeyboardEvent): boolean;
  paste(event: ClipboardEvent, currentTarget: HTMLElement): boolean;
}

function createFeedbackItemNode(
  runtime: WorkflowComposerRuntime,
): Node<undefined, unknown> {
  return Node.create({
    name: FEEDBACK_ITEM_NODE_NAME,
    group: "block",
    content: "paragraph+",
    defining: true,
    isolating: true,
    selectable: false,
    addAttributes() {
      return {
        feedbackId: { default: 0 },
        quote: { default: "" },
        showDivider: { default: false },
        fill: { default: false },
      };
    },
    parseHTML() {
      return [{ tag: "div[data-feedback-item]" }];
    },
    renderHTML({ HTMLAttributes }) {
      return ["div", { ...HTMLAttributes, "data-feedback-item": "" }, 0];
    },
    addNodeView() {
      return ({ node }) => {
        return createFeedbackItemNodeView(node, (id) => {
          runtime.removeFeedback(id);
        });
      };
    },
  });
}

function createWorkflowEditor(runtime: WorkflowComposerRuntime): Editor {
  return new Editor({
    element: null,
    extensions: [
      STARTER_KIT,
      createFeedbackItemNode(runtime),
      ChatThreadMentionNode,
      WorkflowHighlight,
    ],
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

function setWorkflowComposerDocument(
  editor: Editor,
  nextDocument: ProseMirrorNode,
): boolean {
  if (editor.state.doc.eq(nextDocument)) {
    return false;
  }
  editor.commands.setContent(nextDocument, { emitUpdate: false });
  return true;
}

function createMountEditorCommand({
  editor,
  draft,
  runtime,
  caretIndex$,
  editorFocusedState$,
  selectedSuggestionIndexState$,
  feedback,
  autoFocus,
  singleLineOnMobile,
}: {
  editor: Editor;
  draft: DraftSignals;
  runtime: WorkflowComposerRuntime;
  caretIndex$: State<number>;
  editorFocusedState$: State<boolean>;
  selectedSuggestionIndexState$: State<number>;
  feedback: FeedbackSignals;
  autoFocus: boolean;
  singleLineOnMobile: boolean;
}) {
  return onRef(
    command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
      runtime.update = (updatedEditor) => {
        if (get(feedback.active$)) {
          runtime.replaceFeedbackItems(
            feedbackItemsFromWorkflowComposer(updatedEditor),
          );
        } else {
          set(draft.setInput$, workflowComposerDocToString(updatedEditor));
          runtime.input();
        }
        set(selectedSuggestionIndexState$, 0);
        set(caretIndex$, caretStringIndex(updatedEditor));
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
      runtime.replaceFeedbackItems = (items) => {
        set(feedback.replaceFromEditor$, items);
      };
      runtime.removeFeedback = (id) => {
        set(feedback.removeFeedback$, id);
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
      if (!get(feedback.active$)) {
        setWorkflowComposerDocument(
          editor,
          editor.schema.nodeFromJSON(valueToWorkflowComposerDoc(input)),
        );
      }
      editor.mount(element);
      set(draft.setInputSyncTarget$, {
        syncInput(value: string) {
          if (!get(feedback.active$)) {
            setWorkflowComposerDocument(
              editor,
              editor.schema.nodeFromJSON(valueToWorkflowComposerDoc(value)),
            );
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
        runtime.replaceFeedbackItems = () => {};
        runtime.removeFeedback = () => {};
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
    const content: JSONContent[] = [
      {
        type: CHAT_THREAD_MENTION_NODE_NAME,
        attrs: { threadId: chatThread.id, title: chatThread.title },
      },
    ];
    if (!input.slice(range.end).startsWith(" ")) {
      content.push({ type: "text", text: " " });
    }
    editor
      .chain()
      .focus()
      .insertContentAt({ from, to: head }, content)
      // The mention node occupies a single document position; place the
      // caret after the node and the following space.
      .setTextSelection(from + 2)
      .run();
  });
}

function createWorkflowComposerRuntime(): WorkflowComposerRuntime {
  return {
    update(_editor: Editor): void {},
    selectionUpdate(_editor: Editor): void {},
    focus(_editor: Editor): void {},
    blur(): void {},
    input(): void {},
    replaceFeedbackItems(_items: readonly FeedbackItem[]): void {},
    removeFeedback(_id: number): void {},
    keyDown(_event: KeyboardEvent): boolean {
      return false;
    },
    paste: (_event: ClipboardEvent, _currentTarget: HTMLElement) => {
      return false;
    },
  };
}

export function createWorkflowComposerSignals(
  draft: DraftSignals,
  threadId?: string,
): WorkflowComposerSignals {
  const caretIndex$ = state(-1);
  const editorFocusedState$ = state(false);
  const selectedSuggestionIndexState$ = state(0);
  const runtime = createWorkflowComposerRuntime();
  const templatePreview = createTemplatePreviewRuntime();

  const editor = createWorkflowEditor(runtime);
  const feedback = createFeedbackSignals(threadId ?? "", draft, {
    replaceItems(items, draftValue, focusNewest) {
      const activeItems = items && items.length > 0 ? items : null;
      const currentFeedbackCount =
        feedbackItemsFromWorkflowComposer(editor).length;
      const shouldFocusNewest =
        activeItems !== null &&
        focusNewest &&
        activeItems.length > currentFeedbackCount;
      const document = activeItems
        ? feedbackItemsToWorkflowComposerDoc(editor, activeItems)
        : editor.schema.nodeFromJSON(valueToWorkflowComposerDoc(draftValue));
      const changed = setWorkflowComposerDocument(editor, document);
      if (changed && shouldFocusNewest && editor.isInitialized) {
        editor.commands.focus("end");
      }
    },
  });

  const selectedSuggestionIndex$ = computed((get) => {
    return get(selectedSuggestionIndexState$);
  });
  const activeSlashRange$ = computed((get) => {
    if (get(feedback.active$) || !get(editorFocusedState$)) {
      return null;
    }
    return findActiveSlashWorkflowRange(get(draft.input$), get(caretIndex$));
  });
  const activeChatThreadSuggestionRange$ = computed((get) => {
    if (get(feedback.active$) || !get(editorFocusedState$)) {
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
      feedback,
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
    templatePreview,
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
    feedback,
  };
}
