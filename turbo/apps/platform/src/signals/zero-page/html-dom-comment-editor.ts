import { createElement } from "react";
import { IconMessageCircleFilled } from "@tabler/icons-react";
import { renderToStaticMarkup } from "react-dom/server";
import { command, computed, state } from "ccstate";
import {
  type CreateHtmlEditDraftRequest,
  zeroHostContract,
} from "@vm0/api-contracts/contracts/zero-host";
import { zeroUploadsContract } from "@vm0/api-contracts/contracts/zero-uploads";
import { toast } from "@vm0/ui/components/ui/sonner";
import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";
import { onRef, resetSignal, settle, tapError, withCleanup } from "../utils.ts";
import {
  createHtmlDomEditPayload,
  HTML_DOM_EDIT_HOVER_ATTR,
  HTML_DOM_EDIT_OVERLAY_ATTR,
  HTML_DOM_EDIT_SELECTED_ATTR,
  HTML_DOM_NODE_ID_ATTR,
  instrumentHtmlDomEditDocument,
  stripHtmlDomEditOverlays,
} from "../../views/zero-page/html-dom-edit-protocol.ts";
import type {
  HtmlDomEditComment,
  HtmlDomEditDraft,
  HtmlDomEditPayload,
} from "../../views/zero-page/html-dom-edit-types.ts";
import {
  publicAttachmentUrl,
  readableAttachmentResourceUrl,
} from "../../views/zero-page/zero-attachment-url.ts";

export type EditorLoadState =
  | { readonly status: "loading" }
  | {
      readonly html: string;
      readonly nodeIds: readonly string[];
      readonly sourceUrl: string;
      readonly status: "ready";
    }
  | { readonly message: string; readonly status: "error" };

interface CommentPopoverAnchor {
  readonly left: number;
  readonly top: number;
}

interface FrameCleanup {
  readonly run: () => void;
}

export interface HtmlDomCommentEditorModel {
  readonly canAddComment: boolean;
  readonly canSend: boolean;
  readonly commentsOpen: boolean;
  readonly commentText: string;
  readonly commentPopoverAnchor: CommentPopoverAnchor | null;
  readonly comments: readonly HtmlDomEditComment[];
  readonly currentComment: HtmlDomEditComment | null;
  readonly editingCommentId: string | null;
  readonly loadState: EditorLoadState;
  readonly popoverTextAreaKey: string;
  readonly prepared: boolean;
  readonly submitting: boolean;
}

interface LoadHtmlDocumentParams {
  readonly signal: AbortSignal;
  readonly sourceUrl: string;
}

interface UploadHtmlSnapshotParams {
  readonly createClient: ZeroClientFactory;
  readonly html: string;
  readonly signal: AbortSignal;
}

interface SendHtmlDomEditRequestParams {
  readonly onFailed?: () => void;
  readonly onGenerated?: (draft: HtmlDomEditDraft) => Promise<void>;
  readonly onPrepared?: (payload: HtmlDomEditPayload) => Promise<void>;
  readonly onStarted?: () => void;
}

const HTML_DOM_COMMENT_LAYER_ID = "vm0-html-edit-comment-layer";
const MAX_DIRECT_HTML_EDIT_DRAFT_BYTES = 500_000;
const HTML_DOM_COMMENT_MARKER_TARGET_ATTR =
  "data-vm0-html-comment-target-node-id";
const FRAME_COMMENT_MARKER_ICON_SVG = renderToStaticMarkup(
  createElement(IconMessageCircleFilled, {
    "aria-hidden": "true",
    size: 20,
  }),
);

const internalLoadState$ = state<EditorLoadState>({ status: "loading" });
const internalStageElement$ = state<HTMLDivElement | null>(null);
const internalIframeElement$ = state<HTMLIFrameElement | null>(null);
const internalSelectedNodeIds$ = state<readonly string[]>([]);
const internalCommentPopoverAnchor$ = state<CommentPopoverAnchor | null>(null);
const internalEditingCommentId$ = state<string | null>(null);
const internalHoveredNodeId$ = state<string | null>(null);
const internalCommentText$ = state("");
const internalComments$ = state<readonly HtmlDomEditComment[]>([]);
const internalCommentsOpen$ = state(false);
const internalSubmitting$ = state(false);
const internalPreparedPayload$ = state<HtmlDomEditPayload | null>(null);
const internalFrameCleanup$ = state<FrameCleanup | null>(null);
const resetHtmlDomEditRequestSignal$ = resetSignal();

async function uploadHtmlDomEditSnapshot(
  params: UploadHtmlSnapshotParams,
): Promise<string> {
  const filename = `vm0-html-edit-${now()}.html`;
  const client = params.createClient(zeroUploadsContract);
  const uploaded = await accept(
    client.htmlDomEditSnapshot({
      body: {
        filename,
        html: params.html,
      },
      fetchOptions: { signal: params.signal },
    }),
    [200],
  );
  params.signal.throwIfAborted();

  return uploaded.body.url;
}

async function requestHtmlEditDraft(params: {
  readonly comments: readonly HtmlDomEditComment[];
  readonly createClient: ZeroClientFactory;
  readonly html: string;
  readonly signal: AbortSignal;
}): Promise<string> {
  const client = params.createClient(zeroHostContract, { apiBase: "api" });
  const comments = params.comments.map((comment) => {
    return {
      id: comment.id,
      targetNodeIds: [...comment.targetNodeIds],
      comment: comment.comment,
    };
  });
  const body: CreateHtmlEditDraftRequest =
    new TextEncoder().encode(params.html).byteLength <=
    MAX_DIRECT_HTML_EDIT_DRAFT_BYTES
      ? {
          html: params.html,
          comments,
        }
      : {
          htmlSnapshotUrl: await uploadHtmlDomEditSnapshot({
            createClient: params.createClient,
            html: params.html,
            signal: params.signal,
          }),
          comments,
        };
  params.signal.throwIfAborted();

  const draft = await accept(
    client.createHtmlEditDraft({
      body,
      fetchOptions: { signal: params.signal },
    }),
    [200],
    { toast: false },
  );
  params.signal.throwIfAborted();

  return draft.body.html;
}

function htmlDomEditErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function fetchHtmlDomEditDocument(
  params: LoadHtmlDocumentParams,
): Promise<EditorLoadState> {
  const response = await fetch(
    readableAttachmentResourceUrl(params.sourceUrl),
    {
      cache: "reload",
      mode: "cors",
      signal: params.signal,
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to load HTML (${response.status})`);
  }
  const html = await response.text();
  params.signal.throwIfAborted();
  const instrumented = instrumentHtmlDomEditDocument({
    baseHref: params.sourceUrl,
    html,
  });
  return {
    html: instrumented.html,
    nodeIds: instrumented.nodeIds,
    sourceUrl: params.sourceUrl,
    status: "ready",
  };
}

async function loadHtmlDomEditDocument(
  params: LoadHtmlDocumentParams,
): Promise<EditorLoadState> {
  const loaded = await settle(fetchHtmlDomEditDocument(params), params.signal);
  if (loaded.ok) {
    return loaded.value;
  }
  return {
    message: htmlDomEditErrorMessage(loaded.error, "Failed to load HTML"),
    status: "error",
  };
}

function nodeSelector(nodeId: string): string {
  return `[${HTML_DOM_NODE_ID_ATTR}="${nodeId}"]`;
}

function closestCommentNode(target: EventTarget | null): Element | null {
  if (target === null || typeof target !== "object" || !("closest" in target)) {
    return null;
  }
  return (target as Element).closest(`[${HTML_DOM_NODE_ID_ATTR}]`);
}

function closestCommentMarker(target: EventTarget | null): HTMLElement | null {
  if (target === null || typeof target !== "object" || !("closest" in target)) {
    return null;
  }
  return (target as Element).closest<HTMLElement>(
    `[${HTML_DOM_COMMENT_MARKER_TARGET_ATTR}]`,
  );
}

function syncFrameEditState(
  doc: Document | null | undefined,
  params: {
    readonly hoveredNodeId: string | null;
    readonly selectedNodeIds: readonly string[];
  },
): void {
  if (!doc) {
    return;
  }

  for (const element of Array.from(
    doc.querySelectorAll(
      `[${HTML_DOM_EDIT_HOVER_ATTR}], [${HTML_DOM_EDIT_SELECTED_ATTR}]`,
    ),
  )) {
    element.removeAttribute(HTML_DOM_EDIT_HOVER_ATTR);
    element.removeAttribute(HTML_DOM_EDIT_SELECTED_ATTR);
  }

  if (params.hoveredNodeId) {
    doc
      .querySelector(nodeSelector(params.hoveredNodeId))
      ?.setAttribute(HTML_DOM_EDIT_HOVER_ATTR, "true");
  }

  for (const nodeId of params.selectedNodeIds) {
    doc
      .querySelector(nodeSelector(nodeId))
      ?.setAttribute(HTML_DOM_EDIT_SELECTED_ATTR, "true");
  }
}

function installFrameStyles(doc: Document): void {
  if (doc.head.querySelector(`style[${HTML_DOM_EDIT_OVERLAY_ATTR}]`)) {
    return;
  }

  const style = doc.createElement("style");
  style.setAttribute(HTML_DOM_EDIT_OVERLAY_ATTR, "");
  style.textContent = `
    [${HTML_DOM_NODE_ID_ATTR}] {
      cursor: crosshair !important;
    }
    [${HTML_DOM_EDIT_HOVER_ATTR}="true"] {
      outline: 2px solid rgba(37, 99, 235, 0.75) !important;
      outline-offset: 2px !important;
    }
    [${HTML_DOM_EDIT_SELECTED_ATTR}="true"] {
      outline: 2px solid rgb(37, 99, 235) !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.16) !important;
    }
  `;
  doc.head.append(style);
}

function commentId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `comment-${now()}`;
}

function commentPopoverAnchorForElement(params: {
  readonly element: Element;
  readonly iframe: HTMLIFrameElement;
  readonly stage: HTMLElement;
}): CommentPopoverAnchor {
  const elementRect = params.element.getBoundingClientRect();
  const iframeRect = params.iframe.getBoundingClientRect();
  const stageRect = params.stage.getBoundingClientRect();
  const preferredLeft =
    iframeRect.left - stageRect.left + elementRect.left + elementRect.width / 2;
  const preferredTop = iframeRect.top - stageRect.top + elementRect.bottom + 10;

  return {
    left: Math.max(180, Math.min(stageRect.width - 180, preferredLeft)),
    top: Math.max(12, Math.min(stageRect.height - 260, preferredTop)),
  };
}

function serializeFrameDocument(doc: Document): string {
  const doctype = doc.doctype ? `<!doctype ${doc.doctype.name}>\n` : "";
  return `${doctype}${doc.documentElement.outerHTML}`;
}

function htmlWithEditOverlaysRemoved(params: {
  readonly fallbackHtml: string;
  readonly frameDocument: Document | null | undefined;
}): string {
  if (!params.frameDocument) {
    return params.fallbackHtml;
  }
  return stripHtmlDomEditOverlays(serializeFrameDocument(params.frameDocument));
}

function restoreFrameDocumentHtml(params: {
  readonly doc: Document;
  readonly html: string;
}): void {
  const Parser = params.doc.defaultView?.DOMParser ?? DOMParser;
  const parser = new Parser();
  const nextDocument = parser.parseFromString(params.html, "text/html");
  for (const attr of Array.from(params.doc.documentElement.attributes)) {
    params.doc.documentElement.removeAttribute(attr.name);
  }
  for (const attr of Array.from(nextDocument.documentElement.attributes)) {
    params.doc.documentElement.setAttribute(attr.name, attr.value);
  }
  params.doc.head.replaceChildren(
    ...Array.from(nextDocument.head.childNodes, (node) => {
      return params.doc.importNode(node, true);
    }),
  );
  params.doc.body.replaceChildren(
    ...Array.from(nextDocument.body.childNodes, (node) => {
      return params.doc.importNode(node, true);
    }),
  );
  installFrameStyles(params.doc);
}

function commentedTargetNodeIds(
  comments: readonly HtmlDomEditComment[],
): ReadonlySet<string> {
  const nodeIds = new Set<string>();
  for (const comment of comments) {
    const nodeId = comment.targetNodeIds[0];
    if (!nodeId) {
      continue;
    }
    nodeIds.add(nodeId);
  }
  return nodeIds;
}

function commentForSelectedNodes(params: {
  readonly comments: readonly HtmlDomEditComment[];
  readonly selectedNodeIds: readonly string[];
}): HtmlDomEditComment | null {
  return (
    params.comments.find((comment) => {
      return comment.targetNodeIds.some((nodeId) => {
        return params.selectedNodeIds.includes(nodeId);
      });
    }) ?? null
  );
}

function hasCommentForSelectedNodes(params: {
  readonly comments: readonly HtmlDomEditComment[];
  readonly selectedNodeIds: readonly string[];
}): boolean {
  return (
    commentForSelectedNodes({
      comments: params.comments,
      selectedNodeIds: params.selectedNodeIds,
    }) !== null
  );
}

function commentForNodeId(
  comments: readonly HtmlDomEditComment[],
  nodeId: string,
): HtmlDomEditComment | null {
  return (
    comments.find((comment) => {
      return comment.targetNodeIds.includes(nodeId);
    }) ?? null
  );
}

function commentMarkerPosition(params: {
  readonly doc: Document;
  readonly target: Element;
}): { readonly left: number; readonly top: number } {
  const rect = params.target.getBoundingClientRect();
  const viewportWidth = params.doc.documentElement.clientWidth || 320;
  const viewportHeight = params.doc.documentElement.clientHeight || 240;
  return {
    left: Math.max(8, Math.min(viewportWidth - 28, rect.right - 14)),
    top: Math.max(8, Math.min(viewportHeight - 28, rect.top - 14)),
  };
}

function removeFrameCommentLayer(doc: Document): void {
  doc.getElementById(HTML_DOM_COMMENT_LAYER_ID)?.remove();
}

function ensureFrameCommentLayer(doc: Document): HTMLElement {
  let layer: HTMLElement | null = null;
  for (const candidate of Array.from(
    doc.querySelectorAll(`#${HTML_DOM_COMMENT_LAYER_ID}`),
  )) {
    if (candidate instanceof HTMLElement && layer === null) {
      layer = candidate;
      continue;
    }
    candidate.remove();
  }

  if (layer) {
    return layer;
  }

  layer = doc.createElement("div");
  layer.id = HTML_DOM_COMMENT_LAYER_ID;
  layer.setAttribute(HTML_DOM_EDIT_OVERLAY_ATTR, "");
  layer.setAttribute("aria-hidden", "false");
  layer.style.position = "fixed";
  layer.style.setProperty("inset", "0");
  layer.style.zIndex = "2147483647";
  layer.style.pointerEvents = "none";
  doc.body.append(layer);
  return layer;
}

function createFrameCommentMarkerIcon(doc: Document): SVGElement {
  const template = doc.createElement("template");
  template.innerHTML = FRAME_COMMENT_MARKER_ICON_SVG;
  const icon = template.content.firstElementChild;
  const svgElement = doc.defaultView?.SVGElement;
  if (svgElement && icon instanceof svgElement) {
    return icon;
  }
  return doc.createElementNS("http://www.w3.org/2000/svg", "svg");
}

function syncFrameCommentMarkers(
  doc: Document | null | undefined,
  comments: readonly HtmlDomEditComment[],
): void {
  if (!doc) {
    return;
  }

  const commentedNodeIds = commentedTargetNodeIds(comments);
  if (commentedNodeIds.size === 0) {
    removeFrameCommentLayer(doc);
    return;
  }

  const layer = ensureFrameCommentLayer(doc);
  layer.replaceChildren();
  for (const nodeId of commentedNodeIds) {
    const target = doc.querySelector(nodeSelector(nodeId));
    if (!target) {
      continue;
    }

    const position = commentMarkerPosition({ doc, target });
    const marker = doc.createElement("button");
    marker.type = "button";
    marker.append(createFrameCommentMarkerIcon(doc));
    marker.setAttribute(HTML_DOM_EDIT_OVERLAY_ATTR, "");
    marker.setAttribute(HTML_DOM_COMMENT_MARKER_TARGET_ATTR, nodeId);
    marker.dataset.testid = "html-dom-comment-marker";
    marker.setAttribute("aria-label", "Comment");
    marker.style.position = "absolute";
    marker.style.left = `${position.left}px`;
    marker.style.top = `${position.top}px`;
    marker.style.display = "inline-flex";
    marker.style.alignItems = "center";
    marker.style.justifyContent = "center";
    marker.style.width = "28px";
    marker.style.height = "28px";
    marker.style.border = "0";
    marker.style.borderRadius = "0";
    marker.style.background = "transparent";
    marker.style.color = "rgb(59, 130, 246)";
    marker.style.filter = "drop-shadow(0 1px 2px rgba(15, 23, 42, 0.35))";
    marker.style.cursor = "pointer";
    marker.style.pointerEvents = "auto";
    marker.style.padding = "0";
    layer.append(marker);
  }
}

function currentFrameDocument(
  iframe: HTMLIFrameElement | null,
): Document | null {
  return iframe?.contentDocument ?? null;
}

function cleanupCurrentFrameBinding(cleanup: FrameCleanup | null): void {
  cleanup?.run();
}

const cleanupCurrentFrameBinding$ = command(({ get, set }) => {
  cleanupCurrentFrameBinding(get(internalFrameCleanup$));
  set(internalFrameCleanup$, null);
});

const resetHtmlDomCommentEditor$ = command(({ set }) => {
  set(cleanupCurrentFrameBinding$);
  set(internalLoadState$, { status: "loading" });
  set(internalStageElement$, null);
  set(internalIframeElement$, null);
  set(internalSelectedNodeIds$, []);
  set(internalCommentPopoverAnchor$, null);
  set(internalEditingCommentId$, null);
  set(internalHoveredNodeId$, null);
  set(internalCommentText$, "");
  set(internalComments$, []);
  set(internalCommentsOpen$, false);
  set(internalSubmitting$, false);
  set(internalPreparedPayload$, null);
});

export const setHtmlDomCommentStageRef$ = onRef(
  command(async ({ set }, el: HTMLDivElement, signal: AbortSignal) => {
    const url = el.dataset.htmlDomCommentUrl;
    if (!url) {
      return;
    }

    set(resetHtmlDomCommentEditor$);
    set(internalStageElement$, el);
    signal.addEventListener(
      "abort",
      () => {
        set(cleanupCurrentFrameBinding$);
        set(internalStageElement$, null);
      },
      { once: true },
    );

    const sourceUrl = publicAttachmentUrl(url);
    const nextState = await loadHtmlDomEditDocument({
      signal,
      sourceUrl,
    });
    signal.throwIfAborted();
    set(internalLoadState$, nextState);
  }),
);

export const setHtmlDomCommentIframeRef$ = onRef(
  command(({ set }, iframe: HTMLIFrameElement, signal: AbortSignal) => {
    set(internalIframeElement$, iframe);
    signal.addEventListener(
      "abort",
      () => {
        set(cleanupCurrentFrameBinding$);
        set(internalIframeElement$, null);
      },
      { once: true },
    );
  }),
);

interface FrameCommentBindingParams {
  readonly doc: Document;
  readonly getComments: () => readonly HtmlDomEditComment[];
  readonly getDisabled: () => boolean;
  readonly getEditingCommentId: () => string | null;
  readonly getHoveredNodeId: () => string | null;
  readonly hoveredNodeId: string | null;
  readonly iframe: HTMLIFrameElement;
  readonly selectedNodeIds: readonly string[];
  readonly setCommentPopoverAnchor: (
    value: CommentPopoverAnchor | null,
  ) => void;
  readonly setEditingCommentId: (value: string | null) => void;
  readonly setHoveredNodeId: (value: string | null) => void;
  readonly setCommentText: (value: string) => void;
  readonly setSelectedNodeIds: (value: readonly string[]) => void;
  readonly stage: HTMLElement;
}

function frameCommentNodeIdForTarget(
  params: Pick<FrameCommentBindingParams, "getComments">,
  target: EventTarget | null,
): string | null {
  const markerNodeId = closestCommentMarker(target)?.getAttribute(
    HTML_DOM_COMMENT_MARKER_TARGET_ATTR,
  );
  if (markerNodeId) {
    return markerNodeId;
  }

  const nodeId = closestCommentNode(target)?.getAttribute(
    HTML_DOM_NODE_ID_ATTR,
  );
  return nodeId && commentForNodeId(params.getComments(), nodeId)
    ? nodeId
    : null;
}

function closeFrameHoverPopoverForNode(
  params: Pick<
    FrameCommentBindingParams,
    | "getComments"
    | "getEditingCommentId"
    | "setCommentPopoverAnchor"
    | "setCommentText"
    | "setHoveredNodeId"
    | "setSelectedNodeIds"
  >,
  nodeId: string,
): void {
  if (params.getEditingCommentId() !== null) {
    return;
  }
  if (!commentForNodeId(params.getComments(), nodeId)) {
    return;
  }

  params.setHoveredNodeId(null);
  params.setSelectedNodeIds([]);
  params.setCommentPopoverAnchor(null);
  params.setCommentText("");
}

function bindFrameCommentEvents(params: FrameCommentBindingParams): () => void {
  installFrameStyles(params.doc);

  const openPopoverForNode = (nodeId: string, mode: "edit" | "view"): void => {
    const element = params.doc.querySelector(nodeSelector(nodeId));
    if (!element) {
      return;
    }
    const existingComment = commentForNodeId(params.getComments(), nodeId);
    if (mode === "edit" && existingComment) {
      params.setEditingCommentId(existingComment.id);
      params.setCommentText(existingComment.comment);
    } else {
      params.setEditingCommentId(null);
      if (!existingComment) {
        params.setCommentText("");
      }
    }
    params.setSelectedNodeIds([nodeId]);
    params.setCommentPopoverAnchor(
      commentPopoverAnchorForElement({
        element,
        iframe: params.iframe,
        stage: params.stage,
      }),
    );
  };

  const handleMouseOver = (event: Event) => {
    if (params.getDisabled()) {
      return;
    }
    const markerNodeId = closestCommentMarker(event.target)?.getAttribute(
      HTML_DOM_COMMENT_MARKER_TARGET_ATTR,
    );
    if (markerNodeId) {
      params.setHoveredNodeId(markerNodeId);
      openPopoverForNode(markerNodeId, "view");
      return;
    }

    const nodeId = closestCommentNode(event.target)?.getAttribute(
      HTML_DOM_NODE_ID_ATTR,
    );
    params.setHoveredNodeId(nodeId ?? null);
    if (nodeId && commentForNodeId(params.getComments(), nodeId)) {
      openPopoverForNode(nodeId, "view");
    }
  };
  const handleMouseOut = (event: MouseEvent) => {
    const nodeId = frameCommentNodeIdForTarget(params, event.target);
    if (!nodeId) {
      return;
    }

    if (frameCommentNodeIdForTarget(params, event.relatedTarget) === nodeId) {
      return;
    }

    closeFrameHoverPopoverForNode(params, nodeId);
  };
  const handleMouseLeave = () => {
    const nodeId = params.getHoveredNodeId();
    if (nodeId) {
      closeFrameHoverPopoverForNode(params, nodeId);
      return;
    }

    params.setHoveredNodeId(null);
  };
  const handleClick = (event: Event) => {
    if (params.getDisabled()) {
      return;
    }
    const markerNodeId = closestCommentMarker(event.target)?.getAttribute(
      HTML_DOM_COMMENT_MARKER_TARGET_ATTR,
    );
    if (markerNodeId) {
      event.preventDefault();
      event.stopPropagation();
      openPopoverForNode(markerNodeId, "edit");
      return;
    }

    const element = closestCommentNode(event.target);
    const nodeId = element?.getAttribute(HTML_DOM_NODE_ID_ATTR);
    if (!element || !nodeId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    openPopoverForNode(nodeId, "edit");
  };

  params.doc.addEventListener("mouseover", handleMouseOver, true);
  params.doc.addEventListener("mouseout", handleMouseOut, true);
  params.doc.addEventListener("mouseleave", handleMouseLeave, true);
  params.doc.addEventListener("click", handleClick, true);
  syncFrameEditState(params.doc, {
    hoveredNodeId: params.hoveredNodeId,
    selectedNodeIds: params.selectedNodeIds,
  });

  return () => {
    params.doc.removeEventListener("mouseover", handleMouseOver, true);
    params.doc.removeEventListener("mouseout", handleMouseOut, true);
    params.doc.removeEventListener("mouseleave", handleMouseLeave, true);
    params.doc.removeEventListener("click", handleClick, true);
  };
}

export const bindHtmlDomCommentFrame$ = command(
  ({ get, set }, iframe: HTMLIFrameElement) => {
    set(cleanupCurrentFrameBinding$);

    const doc = iframe.contentDocument;
    const stage = get(internalStageElement$);
    if (!doc || !stage) {
      return;
    }

    const syncMarkers = () => {
      syncFrameCommentMarkers(doc, get(internalComments$));
    };
    const view = doc.defaultView;
    view?.addEventListener("scroll", syncMarkers, true);
    view?.addEventListener("resize", syncMarkers);

    const eventCleanup = bindFrameCommentEvents({
      doc,
      getComments: () => {
        return get(internalComments$);
      },
      getDisabled: () => {
        return get(internalSubmitting$);
      },
      getEditingCommentId: () => {
        return get(internalEditingCommentId$);
      },
      getHoveredNodeId: () => {
        return get(internalHoveredNodeId$);
      },
      hoveredNodeId: get(internalHoveredNodeId$),
      iframe,
      selectedNodeIds: get(internalSelectedNodeIds$),
      setCommentPopoverAnchor: (value) => {
        set(internalCommentPopoverAnchor$, value);
      },
      setEditingCommentId: (value) => {
        set(internalEditingCommentId$, value);
      },
      setHoveredNodeId: (value) => {
        set(internalHoveredNodeId$, value);
        syncFrameEditState(doc, {
          hoveredNodeId: value,
          selectedNodeIds: get(internalSelectedNodeIds$),
        });
      },
      setCommentText: (value) => {
        set(internalCommentText$, value);
      },
      setSelectedNodeIds: (value) => {
        set(internalSelectedNodeIds$, value);
        syncFrameEditState(doc, {
          hoveredNodeId: get(internalHoveredNodeId$),
          selectedNodeIds: value,
        });
      },
      stage,
    });

    set(internalFrameCleanup$, {
      run: () => {
        eventCleanup();
        view?.removeEventListener("scroll", syncMarkers, true);
        view?.removeEventListener("resize", syncMarkers);
      },
    });
    syncMarkers();
  },
);

export const setHtmlDomCommentTextareaRef$ = onRef(
  command((_visitor, el: HTMLTextAreaElement, _signal: AbortSignal) => {
    if (el.readOnly) {
      return;
    }

    el.focus();
    const cursorPosition = el.value.length;
    el.setSelectionRange(cursorPosition, cursorPosition);
  }),
);

export const setHtmlDomCommentText$ = command(({ set }, value: string) => {
  set(internalCommentText$, value);
  set(internalPreparedPayload$, null);
});

export const beginEditingCurrentHtmlDomComment$ = command(({ get, set }) => {
  const currentComment = commentForSelectedNodes({
    comments: get(internalComments$),
    selectedNodeIds: get(internalSelectedNodeIds$),
  });
  if (!currentComment) {
    return;
  }

  set(internalEditingCommentId$, currentComment.id);
  set(internalCommentText$, currentComment.comment);
  set(internalPreparedPayload$, null);
});

const resetHtmlDomCommentDraft$ = command(({ get, set }) => {
  set(internalCommentText$, "");
  set(internalSelectedNodeIds$, []);
  set(internalCommentPopoverAnchor$, null);
  set(internalEditingCommentId$, null);
  set(internalPreparedPayload$, null);
  syncFrameEditState(currentFrameDocument(get(internalIframeElement$)), {
    hoveredNodeId: get(internalHoveredNodeId$),
    selectedNodeIds: [],
  });
});

export const addHtmlDomComment$ = command(({ get, set }) => {
  const trimmed = get(internalCommentText$).trim();
  const editingCommentId = get(internalEditingCommentId$);
  const comments = get(internalComments$);
  const selectedNodeIds = get(internalSelectedNodeIds$);
  const iframe = get(internalIframeElement$);

  if (editingCommentId) {
    if (!trimmed) {
      return;
    }
    const nextComments = comments.map((comment) => {
      return comment.id === editingCommentId
        ? { ...comment, comment: trimmed }
        : comment;
    });
    set(internalComments$, nextComments);
    syncFrameCommentMarkers(currentFrameDocument(iframe), nextComments);
    set(resetHtmlDomCommentDraft$);
    return;
  }

  if (
    !trimmed ||
    selectedNodeIds.length === 0 ||
    hasCommentForSelectedNodes({ comments, selectedNodeIds })
  ) {
    return;
  }

  const nextComments = [
    ...comments,
    {
      id: commentId(),
      targetNodeIds: selectedNodeIds,
      comment: trimmed,
    },
  ];
  set(internalComments$, nextComments);
  syncFrameCommentMarkers(currentFrameDocument(iframe), nextComments);
  set(resetHtmlDomCommentDraft$);
});

export const toggleHtmlDomCommentsOpen$ = command(({ get, set }) => {
  set(internalCommentsOpen$, !get(internalCommentsOpen$));
});

export const discardHtmlDomComments$ = command(({ get, set }) => {
  const readyLoadState = get(internalLoadState$);
  const doc = currentFrameDocument(get(internalIframeElement$));

  set(internalComments$, []);
  set(internalCommentsOpen$, false);
  if (readyLoadState.status === "ready" && doc) {
    restoreFrameDocumentHtml({
      doc,
      html: readyLoadState.html,
    });
  } else {
    syncFrameCommentMarkers(doc, []);
  }
  set(resetHtmlDomCommentDraft$);
});

export const sendHtmlDomEditRequest$ = command(
  async (
    { get, set },
    params: SendHtmlDomEditRequestParams,
    _parentSignal: AbortSignal,
  ) => {
    const readyLoadState = get(internalLoadState$);
    const comments = get(internalComments$);
    if (
      readyLoadState.status !== "ready" ||
      comments.length === 0 ||
      get(internalSubmitting$)
    ) {
      return;
    }

    const signal = set(resetHtmlDomEditRequestSignal$);
    set(internalSubmitting$, true);
    set(internalPreparedPayload$, null);

    const submit = async () => {
      const html = htmlWithEditOverlaysRemoved({
        fallbackHtml: readyLoadState.html,
        frameDocument: currentFrameDocument(get(internalIframeElement$)),
      });
      params.onStarted?.();
      if (params.onGenerated) {
        const editRequestId = crypto.randomUUID();
        const draftHtml = await tapError(
          requestHtmlEditDraft({
            comments,
            createClient: get(zeroClient$),
            html,
            signal,
          }),
          (error) => {
            toast.error(
              htmlDomEditErrorMessage(error, "Failed to generate edit"),
            );
          },
        );
        signal.throwIfAborted();
        if (!draftHtml) {
          params.onFailed?.();
          return;
        }
        await params.onGenerated({
          comments,
          editRequestId,
          html: draftHtml,
        });
        signal.throwIfAborted();
        toast.success("Edit draft applied");
        return;
      }

      const htmlSnapshotUrl = await tapError(
        uploadHtmlDomEditSnapshot({
          createClient: get(zeroClient$),
          html,
          signal,
        }),
        (error) => {
          toast.error(htmlDomEditErrorMessage(error, "Failed to prepare edit"));
        },
      );
      signal.throwIfAborted();
      if (!htmlSnapshotUrl) {
        params.onFailed?.();
        return;
      }

      const payload = createHtmlDomEditPayload({
        editRequestId: crypto.randomUUID(),
        htmlSnapshotUrl,
        comments,
      });
      set(internalPreparedPayload$, payload);
      if (params.onPrepared) {
        await params.onPrepared(payload);
        signal.throwIfAborted();
        toast.success("Edit request sent");
        return;
      }
      toast.success("Edit request prepared");
    };

    await withCleanup(submit(), () => {
      if (!signal.aborted) {
        set(internalSubmitting$, false);
      }
    });
  },
);

export const htmlDomCommentEditorModel$ = computed(
  (get): HtmlDomCommentEditorModel => {
    const comments = get(internalComments$);
    const commentText = get(internalCommentText$);
    const editingCommentId = get(internalEditingCommentId$);
    const selectedNodeIds = get(internalSelectedNodeIds$);
    const loadState = get(internalLoadState$);
    const submitting = get(internalSubmitting$);
    const currentComment = commentForSelectedNodes({
      comments,
      selectedNodeIds,
    });

    return {
      canAddComment: editingCommentId
        ? commentText.trim() !== ""
        : selectedNodeIds.length > 0 &&
          commentText.trim() !== "" &&
          !hasCommentForSelectedNodes({ comments, selectedNodeIds }),
      canSend:
        loadState.status === "ready" && comments.length > 0 && !submitting,
      commentsOpen: get(internalCommentsOpen$),
      commentText,
      commentPopoverAnchor: get(internalCommentPopoverAnchor$),
      comments,
      currentComment,
      editingCommentId,
      loadState,
      popoverTextAreaKey: [
        selectedNodeIds.join(":"),
        editingCommentId ?? "new",
        currentComment?.id ?? "draft",
      ].join("|"),
      prepared: get(internalPreparedPayload$) !== null,
      submitting,
    };
  },
);
