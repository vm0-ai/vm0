import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { Editor, Extension, Node, type JSONContent } from "@tiptap/core";
import { Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  Plugin,
  PluginKey,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet, type NodeView } from "@tiptap/pm/view";
import { StarterKit } from "@tiptap/starter-kit";
import { createCompositionGate, type CompositionGate } from "@vm0/ui";
import type { ZeroWorkflowSummary } from "@vm0/api-contracts/contracts/zero-workflows";
import { onRef } from "../utils.ts";
import { currentChatAgentRecordId$ } from "../agent-chat.ts";
import type { DraftSignals } from "./chat-draft.ts";
import {
  createFeedbackSignals,
  formatFeedbackPrompt,
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
  CHAT_THREAD_MENTION_NODE_NAME,
  TEMPLATE_ATTACHMENT_NODE_NAME,
} from "./user-message-document-codec.ts";
import {
  createTemplatePreviewRuntime,
  type TemplatePreviewRuntime,
} from "./template-preview-runtime.ts";
import { createComposerWorkflows } from "./composer-workflows.ts";

type AgentIdValue = string | null | Promise<string | null>;

const EDITOR_CONTENT_CLASS =
  // The editor grows with its content instead of scrolling inside a fixed
  // 200px box: a nested scroll region felt cramped once queued references and
  // typed text stacked up. Overflow is delegated to the surrounding page.
  "w-full whitespace-pre-wrap " +
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
  readonly hasTemplateAttachment$: Computed<boolean>;
  readonly activeSlashRange$: Computed<SlashWorkflowRange | null>;
  readonly activeChatThreadSuggestionRange$: Computed<ChatThreadSuggestionRange | null>;
  readonly chatThreadSuggestions$: Computed<
    Promise<ComposerChatThreadSuggestionResult>
  >;
  readonly agentId$: Computed<Promise<string | null>>;
  readonly workflows$: Computed<Promise<readonly ZeroWorkflowSummary[]>>;
  readonly selectedSuggestionIndex$: Computed<number>;
  readonly setSelectedSuggestionIndex$: Command<void, [number]>;
  readonly closeSuggestionMenu$: Command<void, []>;
  readonly setWorkflowNames$: Command<void, [readonly string[]]>;
  readonly insertWorkflow$: Command<void, [ComposerSlashWorkflow]>;
  readonly insertChatThread$: Command<void, [ComposerChatThreadSuggestion]>;
  readonly insertPromptMarkdown$: Command<void, [string]>;
  readonly insertText$: Command<void, [string]>;
  readonly appendText$: Command<void, [string]>;
  readonly readInputForSubmission$: Command<Promise<string>, [AbortSignal]>;
  readonly setTemplateAttachmentLifecycleRef$: Command<
    (() => void) | undefined,
    [HTMLButtonElement | null]
  >;
  readonly setEventHandlers$: Command<void, [WorkflowComposerEventHandlers]>;
  readonly feedback: FeedbackSignals;
}

export type ComposerTemplateAttachmentType =
  | "presentation"
  | "illustration"
  | "video"
  | "workflow"
  | "website";

export interface ComposerTemplateAttachment {
  readonly type: ComposerTemplateAttachmentType;
  readonly title: string;
  readonly category: string;
  readonly previewImageUrl?: string;
}

export interface WorkflowComposerEventHandlers {
  readonly onInput: () => void;
  readonly onKeyDown: (event: KeyboardEvent) => boolean;
  readonly onPaste: (
    event: ClipboardEvent,
    currentTarget: HTMLElement,
  ) => boolean;
}

function createComposerAgentResources<T extends AgentIdValue>(
  agentIdSource$: Computed<T>,
) {
  const agentId$ = computed(async (get): Promise<string | null> => {
    return await get(agentIdSource$);
  });
  return { agentId$, workflows$: createComposerWorkflows(agentId$) };
}

function createComposerFeedback(threadId: string | undefined, editor: Editor) {
  return createFeedbackSignals(threadId ?? "", {
    insertItem(item) {
      insertFeedbackItem(editor, item);
    },
    removeItem(id) {
      removeFeedbackItem(editor, id);
    },
  });
}

const FEEDBACK_ITEM_NODE_NAME = "feedbackItem";
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

function createComposerIcon(
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
  const quoteIcon = createComposerIcon(12, 1.5, [
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
    createComposerIcon(14, 1.8, ["M18 6l-12 12", "M6 6l12 12"]),
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

function templateAttachmentNodeAttributes(
  node: ProseMirrorNode,
): ComposerTemplateAttachment {
  const type: unknown = node.attrs.templateType;
  const title: unknown = node.attrs.title;
  const category: unknown = node.attrs.category;
  const previewImageUrl: unknown = node.attrs.previewImageUrl;
  if (
    (type !== "presentation" &&
      type !== "illustration" &&
      type !== "video" &&
      type !== "workflow" &&
      type !== "website") ||
    typeof title !== "string" ||
    typeof category !== "string" ||
    (previewImageUrl !== null && typeof previewImageUrl !== "string")
  ) {
    throw new Error("Template attachment node attributes are invalid");
  }
  return {
    type,
    title,
    category,
    ...(previewImageUrl === null ? {} : { previewImageUrl }),
  };
}

function templateAttachmentPreviewLabel(
  attachment: ComposerTemplateAttachment,
): string {
  if (attachment.type === "video") {
    return `Preview video template ${attachment.title}`;
  }
  if (attachment.type === "workflow") {
    return `Preview workflow template ${attachment.title}`;
  }
  if (attachment.type === "website") {
    return `Preview website template ${attachment.title}`;
  }
  return `Preview template ${attachment.title}`;
}

function templateAttachmentRemoveLabel(
  attachment: ComposerTemplateAttachment,
): string {
  if (attachment.type === "video") {
    return `Remove video template ${attachment.title}`;
  }
  if (attachment.type === "workflow") {
    return `Remove workflow template ${attachment.title}`;
  }
  if (attachment.type === "website") {
    return `Remove website template ${attachment.title}`;
  }
  return `Remove template ${attachment.title}`;
}

function templateAttachmentTypeLabel(
  type: ComposerTemplateAttachmentType,
): string {
  return `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
}

function createTemplateAttachmentNodeView(
  node: ProseMirrorNode,
  openTemplate: (category: string) => void,
  removeTemplate: () => void,
): NodeView {
  const dom = document.createElement("div");
  dom.dataset.composerTemplateAttachment = "";
  dom.className = "flex pb-1.5";
  dom.contentEditable = "false";

  const chip = document.createElement("div");
  chip.className =
    "inline-flex h-8 max-w-full items-center gap-1 rounded-lg border " +
    "border-border/80 bg-background/90 pl-1 pr-1 text-foreground " +
    "shadow-[0_1px_2px_rgba(15,23,42,0.05)]";
  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.className =
    "flex min-w-0 items-center gap-2 rounded-md px-1 py-1 " +
    "transition-colors hover:bg-muted focus-visible:outline-none " +
    "focus-visible:ring-2 focus-visible:ring-ring";
  const iconContainer = document.createElement("span");
  iconContainer.className =
    "flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden " +
    "rounded-md bg-muted";
  const typeText = document.createElement("span");
  typeText.className = "shrink-0 text-[11px] font-medium text-muted-foreground";
  const divider = document.createElement("span");
  divider.className = "h-3.5 w-px shrink-0 bg-border/70";
  const titleText = document.createElement("span");
  titleText.className = "min-w-0 truncate text-xs font-medium";
  openButton.append(iconContainer, typeText, divider, titleText);

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className =
    "flex h-6 w-6 shrink-0 items-center justify-center rounded-md " +
    "text-muted-foreground/70 transition-colors hover:bg-muted " +
    "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 " +
    "focus-visible:ring-ring";
  removeButton.append(
    createComposerIcon(14, 1.8, ["M18 6l-12 12", "M6 6l12 12"]),
  );
  chip.append(openButton, removeButton);
  dom.append(chip);

  let currentNode = node;
  function render(nextNode: ProseMirrorNode): void {
    const attachment = templateAttachmentNodeAttributes(nextNode);
    openButton.setAttribute(
      "aria-label",
      templateAttachmentPreviewLabel(attachment),
    );
    removeButton.setAttribute(
      "aria-label",
      templateAttachmentRemoveLabel(attachment),
    );
    removeButton.title = templateAttachmentRemoveLabel(attachment);
    typeText.textContent = templateAttachmentTypeLabel(attachment.type);
    titleText.textContent = attachment.title;
    iconContainer.replaceChildren();
    if (attachment.previewImageUrl) {
      const image = document.createElement("img");
      image.src = attachment.previewImageUrl;
      image.alt = "";
      image.className = "h-full w-full object-cover";
      iconContainer.append(image);
    } else {
      const icon = createComposerIcon(12, 1.5, [
        "M4 4h16v16h-16z",
        "M8 8h8",
        "M8 12h8",
        "M8 16h5",
      ]);
      icon.setAttribute("class", "text-muted-foreground");
      iconContainer.append(icon);
    }
  }
  openButton.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  openButton.addEventListener("click", () => {
    openTemplate(templateAttachmentNodeAttributes(currentNode).category);
  });
  removeButton.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  removeButton.addEventListener("click", removeTemplate);
  render(currentNode);

  return {
    dom,
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
        event.target instanceof globalThis.Node && dom.contains(event.target)
      );
    },
    ignoreMutation() {
      return true;
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
  return nodeText(node);
}

function feedbackItemNode(editor: Editor, item: FeedbackItem): ProseMirrorNode {
  return editor.schema.nodeFromJSON({
    type: FEEDBACK_ITEM_NODE_NAME,
    attrs: {
      feedbackId: item.id,
      quote: item.quote,
      showDivider: false,
      fill: false,
    },
    content: feedbackNoteContent(item.note),
  });
}

function withFeedbackItemLayout(transaction: Transaction): Transaction {
  const feedbackNodes: {
    readonly node: ProseMirrorNode;
    readonly position: number;
  }[] = [];
  let position = 0;
  for (let index = 0; index < transaction.doc.childCount; index++) {
    const node = transaction.doc.child(index);
    if (node.type.name === FEEDBACK_ITEM_NODE_NAME) {
      feedbackNodes.push({ node, position });
    }
    position += node.nodeSize;
  }
  for (const [index, feedbackNode] of feedbackNodes.entries()) {
    const { node, position: nodePosition } = feedbackNode;
    const attributes = feedbackItemNodeAttributes(node);
    const showDivider = index > 0;
    const fill = index === feedbackNodes.length - 1;
    if (attributes.showDivider === showDivider && attributes.fill === fill) {
      continue;
    }
    transaction.setNodeMarkup(nodePosition, undefined, {
      ...attributes,
      showDivider,
      fill,
    });
  }
  return transaction;
}

function isEmptyComposerDocument(document: ProseMirrorNode): boolean {
  return (
    document.childCount === 1 &&
    document.firstChild?.type.name === "paragraph" &&
    document.firstChild.content.size === 0
  );
}

function insertFeedbackItem(editor: Editor, item: FeedbackItem): void {
  const node = feedbackItemNode(editor, item);
  const transaction = isEmptyComposerDocument(editor.state.doc)
    ? editor.state.tr.replaceWith(0, editor.state.doc.content.size, node)
    : editor.state.tr.insert(editor.state.doc.content.size, node);
  editor.view.dispatch(withFeedbackItemLayout(transaction).scrollIntoView());
  editor.commands.focus("end");
}

function removeFeedbackItem(editor: Editor, id: number): void {
  let itemPosition: number | null = null;
  let itemSize = 0;
  let position = 0;
  for (let index = 0; index < editor.state.doc.childCount; index++) {
    const node = editor.state.doc.child(index);
    if (
      node.type.name === FEEDBACK_ITEM_NODE_NAME &&
      feedbackItemNodeAttributes(node).feedbackId === id
    ) {
      itemPosition = position;
      itemSize = node.nodeSize;
      break;
    }
    position += node.nodeSize;
  }
  if (itemPosition === null) {
    return;
  }
  const transaction = editor.state.tr.delete(
    itemPosition,
    itemPosition + itemSize,
  );
  if (transaction.doc.childCount === 0) {
    transaction.insert(0, editor.schema.node("paragraph"));
  }
  editor.view.dispatch(withFeedbackItemLayout(transaction).scrollIntoView());
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

interface LocatedTemplateAttachment {
  readonly node: ProseMirrorNode;
  readonly position: number;
}

function locateTemplateAttachment(
  document: ProseMirrorNode,
): LocatedTemplateAttachment | null {
  let position = 0;
  for (let index = 0; index < document.childCount; index++) {
    const node = document.child(index);
    if (node.type.name === TEMPLATE_ATTACHMENT_NODE_NAME) {
      return { node, position };
    }
    position += node.nodeSize;
  }
  return null;
}

function templateAttachmentsEqual(
  first: ComposerTemplateAttachment,
  second: ComposerTemplateAttachment,
): boolean {
  return (
    first.type === second.type &&
    first.title === second.title &&
    first.category === second.category &&
    first.previewImageUrl === second.previewImageUrl
  );
}

function isComposerTemplateAttachmentType(
  value: string | undefined,
): value is ComposerTemplateAttachmentType {
  return (
    value === "presentation" ||
    value === "illustration" ||
    value === "video" ||
    value === "workflow" ||
    value === "website"
  );
}

function templateAttachmentFromLifecycleElement(
  element: HTMLButtonElement,
): ComposerTemplateAttachment | undefined {
  const { templateType, templateTitle, templateCategory, templatePreviewUrl } =
    element.dataset;
  if (
    !isComposerTemplateAttachmentType(templateType) ||
    templateTitle === undefined ||
    templateCategory === undefined
  ) {
    return undefined;
  }
  return {
    type: templateType,
    title: templateTitle,
    category: templateCategory,
    previewImageUrl: templatePreviewUrl || undefined,
  };
}

function templateAttachmentNode(
  editor: Editor,
  attachment: ComposerTemplateAttachment,
): ProseMirrorNode {
  return editor.schema.nodeFromJSON({
    type: TEMPLATE_ATTACHMENT_NODE_NAME,
    attrs: {
      templateType: attachment.type,
      title: attachment.title,
      category: attachment.category,
      previewImageUrl: attachment.previewImageUrl ?? null,
    },
  });
}

function setTemplateAttachmentNode(
  editor: Editor,
  attachment: ComposerTemplateAttachment | undefined,
): void {
  const located = locateTemplateAttachment(editor.state.doc);
  if (!attachment) {
    if (!located) {
      return;
    }
    const transaction = editor.state.tr.delete(
      located.position,
      located.position + located.node.nodeSize,
    );
    if (transaction.doc.childCount === 0) {
      transaction.insert(0, editor.schema.node("paragraph"));
    }
    editor.view.dispatch(transaction.scrollIntoView());
    return;
  }
  if (located) {
    const currentAttachment = templateAttachmentNodeAttributes(located.node);
    if (templateAttachmentsEqual(currentAttachment, attachment)) {
      return;
    }
    editor.view.dispatch(
      editor.state.tr
        .setNodeMarkup(located.position, undefined, {
          templateType: attachment.type,
          title: attachment.title,
          category: attachment.category,
          previewImageUrl: attachment.previewImageUrl ?? null,
        })
        .scrollIntoView(),
    );
    return;
  }
  editor.view.dispatch(
    editor.state.tr
      .insert(0, templateAttachmentNode(editor, attachment))
      .scrollIntoView(),
  );
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

function nodeText(
  node: ProseMirrorNode,
  to: number = node.content.size,
): string {
  return node.textBetween(0, to, "\n", (leafNode) => {
    if (leafNode.type.name === CHAT_THREAD_MENTION_NODE_NAME) {
      return chatThreadMentionText(leafNode);
    }
    return leafNode.type.name === "hardBreak" ? "\n" : "";
  });
}

function workflowComposerDocToString(editor: Editor): string {
  const sections: string[] = [];
  let textBlocks: string[] = [];
  let feedbackItems: FeedbackItem[] = [];
  const flushTextBlocks = () => {
    const text = textBlocks.join("\n");
    if (text.trim().length > 0) {
      sections.push(text);
    }
    textBlocks = [];
  };
  const flushFeedbackItems = () => {
    const notedItems = feedbackItems.filter((item) => {
      return item.note.trim().length > 0;
    });
    if (notedItems.length > 0) {
      sections.push(formatFeedbackPrompt(notedItems));
    }
    feedbackItems = [];
  };

  for (let index = 0; index < editor.state.doc.childCount; index++) {
    const node = editor.state.doc.child(index);
    if (node.type.name === TEMPLATE_ATTACHMENT_NODE_NAME) {
      continue;
    }
    if (node.type.name === FEEDBACK_ITEM_NODE_NAME) {
      flushTextBlocks();
      const attributes = feedbackItemNodeAttributes(node);
      feedbackItems.push({
        id: attributes.feedbackId,
        quote: attributes.quote,
        note: feedbackNoteFromNode(node),
      });
      continue;
    }
    flushFeedbackItems();
    textBlocks.push(nodeText(node));
  }
  flushTextBlocks();
  flushFeedbackItems();
  return sections.join("\n\n");
}

interface ActiveTextblock {
  readonly value: string;
  readonly caretIndex: number;
}

function activeTextblock(editor: Editor): ActiveTextblock | null {
  const { $head } = editor.state.selection;
  if (!$head.parent.isTextblock) {
    return null;
  }
  return {
    value: nodeText($head.parent),
    caretIndex: nodeText($head.parent, $head.parentOffset).length,
  };
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
  templateAttachment: ComposerTemplateAttachment | undefined;
  openTemplate(category: string): void;
  removeTemplate(): void;
  templateRemoved(): void;
  replaceFeedbackItems(items: readonly FeedbackItem[]): void;
  removeFeedback(id: number): void;
  keyDown(event: KeyboardEvent): boolean;
  paste(event: ClipboardEvent, currentTarget: HTMLElement): boolean;
}

function createTemplateAttachmentNode(
  runtime: WorkflowComposerRuntime,
): Node<undefined, unknown> {
  return Node.create({
    name: TEMPLATE_ATTACHMENT_NODE_NAME,
    group: "block",
    atom: true,
    defining: true,
    isolating: true,
    selectable: false,
    addAttributes() {
      return {
        templateType: { default: "presentation" },
        title: { default: "" },
        category: { default: "slides" },
        previewImageUrl: { default: null },
      };
    },
    parseHTML() {
      return [{ tag: "div[data-composer-template-attachment]" }];
    },
    renderHTML({ HTMLAttributes }) {
      return [
        "div",
        { ...HTMLAttributes, "data-composer-template-attachment": "" },
      ];
    },
    addNodeView() {
      return ({ node }) => {
        return createTemplateAttachmentNodeView(
          node,
          (category) => {
            runtime.openTemplate(category);
          },
          () => {
            runtime.removeTemplate();
          },
        );
      };
    },
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey("templateAttachmentGuard"),
          appendTransaction(_transactions, _oldState, newState) {
            const attachment = runtime.templateAttachment;
            if (
              attachment === undefined ||
              locateTemplateAttachment(newState.doc) !== null
            ) {
              return null;
            }
            return newState.tr.insert(
              0,
              newState.schema.node(TEMPLATE_ATTACHMENT_NODE_NAME, {
                templateType: attachment.type,
                title: attachment.title,
                category: attachment.category,
                previewImageUrl: attachment.previewImageUrl ?? null,
              }),
            );
          },
        }),
      ];
    },
  });
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
      createTemplateAttachmentNode(runtime),
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

function workflowComposerDocumentForValue(
  editor: Editor,
  value: string,
): ProseMirrorNode {
  const textDocument = editor.schema.nodeFromJSON(
    valueToWorkflowComposerDoc(value),
  );
  const templateAttachment = locateTemplateAttachment(editor.state.doc)?.node;
  if (!templateAttachment) {
    return textDocument;
  }
  const content = [templateAttachment];
  for (let index = 0; index < textDocument.childCount; index++) {
    content.push(textDocument.child(index));
  }
  return editor.schema.node("doc", undefined, content);
}

function createMountEditorCommand({
  editor,
  draft,
  runtime,
  caretIndex$,
  editorFocusedState$,
  selectedSuggestionIndexState$,
  feedback,
  compositionGate,
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
  compositionGate: CompositionGate;
  autoFocus: boolean;
  singleLineOnMobile: boolean;
}) {
  return onRef(
    command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
      runtime.update = (updatedEditor) => {
        runtime.replaceFeedbackItems(
          feedbackItemsFromWorkflowComposer(updatedEditor),
        );
        set(draft.setInput$, workflowComposerDocToString(updatedEditor));
        runtime.input();
        set(selectedSuggestionIndexState$, 0);
        set(caretIndex$, updatedEditor.state.selection.head);
        compositionGate.notifySettled();
      };
      runtime.selectionUpdate = (updatedEditor) => {
        set(caretIndex$, updatedEditor.state.selection.head);
      };
      runtime.focus = (focusedEditor) => {
        set(editorFocusedState$, true);
        set(caretIndex$, focusedEditor.state.selection.head);
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
      if (feedbackItemsFromWorkflowComposer(editor).length === 0) {
        setWorkflowComposerDocument(
          editor,
          workflowComposerDocumentForValue(editor, input),
        );
      }
      editor.mount(element);
      editor.view.dom.addEventListener(
        "compositionstart",
        compositionGate.compositionStart,
        { signal },
      );
      editor.view.dom.addEventListener(
        "compositionend",
        compositionGate.compositionEnd,
        { signal },
      );
      set(draft.setInputSyncTarget$, {
        syncInput(value: string) {
          if (workflowComposerDocToString(editor) === value) {
            return;
          }
          const changed = setWorkflowComposerDocument(
            editor,
            workflowComposerDocumentForValue(editor, value),
          );
          if (changed) {
            runtime.replaceFeedbackItems(
              feedbackItemsFromWorkflowComposer(editor),
            );
          }
        },
      });
      if (autoFocus && !isIOS()) {
        editor.commands.focus("end");
      }
      signal.addEventListener("abort", () => {
        compositionGate.cancel(signal.reason);
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
  activeSlashRange$: Computed<SlashWorkflowRange | null>,
) {
  return command(({ get }, workflow: ComposerSlashWorkflow) => {
    const slashRange = get(activeSlashRange$);
    if (!slashRange) {
      return;
    }
    const textblock = activeTextblock(editor);
    if (!textblock) {
      return;
    }
    const head = editor.state.selection.head;
    const from = head - (slashRange.end - slashRange.start);
    const token = `/${workflow.name}`;
    const suffix = textblock.value.slice(slashRange.end).startsWith(" ")
      ? ""
      : " ";
    editor
      .chain()
      .focus()
      .insertContentAt({ from, to: head }, [
        { type: "text", text: `${token}${suffix}` },
      ])
      .setTextSelection(from + token.length + suffix.length)
      .run();
  });
}

function createInsertChatThreadCommand(
  editor: Editor,
  activeRange$: Computed<ChatThreadSuggestionRange | null>,
) {
  return command(({ get }, chatThread: ComposerChatThreadSuggestion) => {
    const range = get(activeRange$);
    if (!range) {
      return;
    }
    const textblock = activeTextblock(editor);
    if (!textblock) {
      return;
    }
    const head = editor.state.selection.head;
    const from = head - (range.end - range.start);
    const content: JSONContent[] = [
      {
        type: CHAT_THREAD_MENTION_NODE_NAME,
        attrs: { threadId: chatThread.id, title: chatThread.title },
      },
    ];
    if (!textblock.value.slice(range.end).startsWith(" ")) {
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

function createInsertTextCommands(editor: Editor) {
  const insertText$ = command((_context, value: string) => {
    editor.chain().focus().insertContent(value).run();
  });
  const insertPromptMarkdown$ = command((_context, value: string) => {
    const doc = editor.schema.nodeFromJSON(valueToWorkflowComposerDoc(value));
    const slice = Slice.maxOpen(doc.content, true);
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.replaceSelection(slice);
        return true;
      })
      .scrollIntoView()
      .run();
  });
  const appendText$ = command((_context, value: string) => {
    const text = value.trim();
    if (!text) {
      return;
    }
    editor.commands.focus("end");
    const textblock = activeTextblock(editor);
    const content = textblock?.value.trimEnd() ? `\n${text}` : text;
    editor.commands.insertContent(content);
  });
  return { insertText$, insertPromptMarkdown$, appendText$ };
}

function createWorkflowComposerRuntime(): WorkflowComposerRuntime {
  return {
    update(_editor: Editor): void {},
    selectionUpdate(_editor: Editor): void {},
    focus(_editor: Editor): void {},
    blur(): void {},
    input(): void {},
    templateAttachment: undefined,
    openTemplate(_category: string): void {},
    removeTemplate(): void {},
    templateRemoved(): void {},
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

function createTemplateAttachmentControls(
  editor: Editor,
  runtime: WorkflowComposerRuntime,
) {
  const activeState$ = state(false);
  runtime.removeTemplate = () => {
    if (runtime.templateAttachment === undefined) {
      return;
    }
    runtime.templateAttachment = undefined;
    setTemplateAttachmentNode(editor, undefined);
    runtime.templateRemoved();
  };
  const setLifecycleRef$ = onRef(
    command(({ set }, element: HTMLButtonElement, signal: AbortSignal) => {
      const attachment = templateAttachmentFromLifecycleElement(element);
      runtime.templateAttachment = attachment;
      set(activeState$, attachment !== undefined);
      setTemplateAttachmentNode(editor, attachment);
      runtime.openTemplate = (category) => {
        element.dataset.templateAction = "open";
        element.dataset.templateCategory = category;
        element.click();
      };
      runtime.templateRemoved = () => {
        element.dataset.templateAction = "remove";
        element.click();
      };
      signal.addEventListener("abort", () => {
        runtime.templateAttachment = undefined;
        runtime.openTemplate = () => {};
        runtime.templateRemoved = () => {};
        set(activeState$, false);
        setTemplateAttachmentNode(editor, undefined);
      });
    }),
  );
  const active$ = computed((get) => {
    return get(activeState$);
  });
  return { active$, setLifecycleRef$ };
}

export function createWorkflowComposerSignals<
  T extends AgentIdValue = Promise<string | null>,
>(
  draft: DraftSignals,
  threadId?: string,
  agentIdSource$: Computed<T> = currentChatAgentRecordId$ as Computed<T>,
): WorkflowComposerSignals {
  const caretIndex$ = state(-1);
  const editorFocusedState$ = state(false);
  const selectedSuggestionIndexState$ = state(0);
  const runtime = createWorkflowComposerRuntime();
  const templatePreview = createTemplatePreviewRuntime();
  const compositionGate = createCompositionGate();
  const { agentId$, workflows$ } = createComposerAgentResources(agentIdSource$);

  const editor = createWorkflowEditor(runtime);
  const templateAttachment = createTemplateAttachmentControls(editor, runtime);
  const feedback = createComposerFeedback(threadId, editor);

  const selectedSuggestionIndex$ = computed((get) => {
    return get(selectedSuggestionIndexState$);
  });
  const activeSlashRange$ = computed((get) => {
    const caretIndex = get(caretIndex$);
    if (caretIndex < 0 || !get(editorFocusedState$)) {
      return null;
    }
    const textblock = activeTextblock(editor);
    return textblock
      ? findActiveSlashWorkflowRange(textblock.value, textblock.caretIndex)
      : null;
  });
  const activeChatThreadSuggestionRange$ = computed((get) => {
    const caretIndex = get(caretIndex$);
    if (caretIndex < 0 || !get(editorFocusedState$)) {
      return null;
    }
    const textblock = activeTextblock(editor);
    return textblock
      ? findActiveChatThreadSuggestionRange(
          textblock.value,
          textblock.caretIndex,
        )
      : null;
  });
  const chatThreadSuggestions$ = createComposerChatThreadSuggestions(
    activeChatThreadSuggestionRange$,
    agentId$,
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
      compositionGate,
      autoFocus,
      singleLineOnMobile,
    });
  };
  const insertWorkflow$ = createInsertWorkflowCommand(
    editor,
    activeSlashRange$,
  );
  const insertChatThread$ = createInsertChatThreadCommand(
    editor,
    activeChatThreadSuggestionRange$,
  );
  const textCommands = createInsertTextCommands(editor);
  const readInputForSubmission$ = command((_context, signal: AbortSignal) => {
    return compositionGate.runWhenSettled(() => {
      return workflowComposerDocToString(editor);
    }, signal);
  });
  const hasInput$ = computed((get) => {
    return get(draft.hasInput$) || get(feedback.active$);
  });

  return {
    editor,
    templatePreview,
    setContainerRef$: mountEditor(false, false),
    setAutoFocusContainerRef$: mountEditor(true, false),
    setCompactContainerRef$: mountEditor(false, true),
    focus$,
    hasInput$,
    hasTemplateAttachment$: templateAttachment.active$,
    activeSlashRange$,
    activeChatThreadSuggestionRange$,
    chatThreadSuggestions$,
    agentId$,
    workflows$,
    selectedSuggestionIndex$,
    setSelectedSuggestionIndex$,
    closeSuggestionMenu$,
    setWorkflowNames$,
    insertWorkflow$,
    insertChatThread$,
    ...textCommands,
    readInputForSubmission$,
    setTemplateAttachmentLifecycleRef$: templateAttachment.setLifecycleRef$,
    setEventHandlers$,
    feedback,
  };
}
