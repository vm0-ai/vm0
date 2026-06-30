import { createElement } from "react";
import { IconPointer } from "@tabler/icons-react";
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
  stripHtmlDomEditOverlaysFromDocument,
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

type CommentMarkerPlacement = "bottom" | "left" | "right" | "top";

interface CommentMarkerRect {
  readonly bottom: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly width: number;
}

interface CommentMarkerPosition {
  readonly placement: CommentMarkerPlacement;
  readonly rect: CommentMarkerRect;
}

const HTML_DOM_COMMENT_LAYER_ID = "vm0-html-edit-comment-layer";
const MAX_DIRECT_HTML_EDIT_DRAFT_BYTES = 500_000;
const HTML_DOM_COMMENT_MARKER_TARGET_ATTR =
  "data-vm0-html-comment-target-node-id";
const HTML_DOM_COMMENT_DELETE_ATTR = "data-vm0-html-comment-delete-id";
const HTML_DOM_COMMENT_FLASH_ATTR = "data-vm0-html-comment-flash";
const FRAME_COMMENT_MARKER_PLACEMENT_ATTR = "data-vm0-html-comment-placement";
const FRAME_COMMENT_LABEL_MAX_WIDTH = 136;
const FRAME_COMMENT_LABEL_LINE_HEIGHT = 20;
const FRAME_COMMENT_LABEL_VERTICAL_PADDING = 16;
const FRAME_COMMENT_LABEL_MAX_LINES = 2;
const FRAME_COMMENT_LABEL_HEIGHT =
  FRAME_COMMENT_LABEL_MAX_LINES * FRAME_COMMENT_LABEL_LINE_HEIGHT +
  FRAME_COMMENT_LABEL_VERTICAL_PADDING;
const FRAME_COMMENT_CONNECTOR_GAP = 36;
const FRAME_COMMENT_DOT_SIZE = 8;
const FRAME_COMMENT_VIEWPORT_PADDING = 8;
const FRAME_COMMENT_COLLISION_GAP = 6;
const FRAME_COMMENT_NUDGE_STEP = 12;
const FRAME_COMMENT_NUDGE_STEPS = [0, 1, -1, 2, -2] as const;
const FRAME_NAVIGATION_CURSOR_SVG = renderToStaticMarkup(
  createElement(IconPointer, {
    "aria-hidden": "true",
    color: "#2563eb",
    size: 20,
    stroke: 2.6,
  }),
);
const FRAME_NAVIGATION_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  FRAME_NAVIGATION_CURSOR_SVG,
)}") 3 3, pointer`;

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

function closestCommentDeleteButton(
  target: EventTarget | null,
): HTMLElement | null {
  if (target === null || typeof target !== "object" || !("closest" in target)) {
    return null;
  }
  return (target as Element).closest<HTMLElement>(
    `[${HTML_DOM_COMMENT_DELETE_ATTR}]`,
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
      cursor: ${FRAME_NAVIGATION_CURSOR} !important;
    }
    [${HTML_DOM_EDIT_HOVER_ATTR}="true"] {
      outline: 2px dashed rgba(37, 99, 235, 0.75) !important;
      outline-offset: 2px !important;
    }
    [${HTML_DOM_EDIT_SELECTED_ATTR}="true"] {
      outline: 2px solid rgb(37, 99, 235) !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.16) !important;
    }
    [${HTML_DOM_COMMENT_MARKER_TARGET_ATTR}]:hover [${HTML_DOM_COMMENT_DELETE_ATTR}],
    [${HTML_DOM_COMMENT_DELETE_ATTR}]:focus-visible {
      opacity: 1 !important;
      pointer-events: auto !important;
    }
    [${HTML_DOM_COMMENT_FLASH_ATTR}="true"] {
      animation: vm0-html-comment-flash 900ms ease-out both !important;
    }
    @keyframes vm0-html-comment-flash {
      0%, 100% {
        box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.16) !important;
      }
      35% {
        box-shadow:
          0 0 0 5px rgba(37, 99, 235, 0.28),
          0 0 0 14px rgba(37, 99, 235, 0.16) !important;
      }
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

function htmlWithEditOverlaysRemoved(params: {
  readonly fallbackHtml: string;
  readonly frameDocument: Document | null | undefined;
}): string {
  if (!params.frameDocument) {
    return params.fallbackHtml;
  }
  return stripHtmlDomEditOverlaysFromDocument(params.frameDocument);
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

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function commentMarkerRect(params: {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}): CommentMarkerRect {
  return {
    bottom: params.top + params.height,
    height: params.height,
    left: params.left,
    right: params.left + params.width,
    top: params.top,
    width: params.width,
  };
}

function commentMarkerRectsOverlap(
  first: CommentMarkerRect,
  second: CommentMarkerRect,
): boolean {
  return !(
    first.right + FRAME_COMMENT_COLLISION_GAP <= second.left ||
    second.right + FRAME_COMMENT_COLLISION_GAP <= first.left ||
    first.bottom + FRAME_COMMENT_COLLISION_GAP <= second.top ||
    second.bottom + FRAME_COMMENT_COLLISION_GAP <= first.top
  );
}

function commentMarkerCollides(
  rect: CommentMarkerRect,
  occupiedRects: readonly CommentMarkerRect[],
): boolean {
  return occupiedRects.some((occupied) => {
    return commentMarkerRectsOverlap(rect, occupied);
  });
}

function targetIntersectsViewport(params: {
  readonly doc: Document;
  readonly target: Element;
}): boolean {
  const rect = params.target.getBoundingClientRect();
  if (
    rect.bottom === 0 &&
    rect.height === 0 &&
    rect.left === 0 &&
    rect.right === 0 &&
    rect.top === 0 &&
    rect.width === 0
  ) {
    return true;
  }

  const viewportWidth =
    params.doc.documentElement.clientWidth ||
    params.doc.defaultView?.innerWidth ||
    320;
  const viewportHeight =
    params.doc.documentElement.clientHeight ||
    params.doc.defaultView?.innerHeight ||
    240;

  return (
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.left < viewportWidth &&
    rect.top < viewportHeight
  );
}

function markerCandidateRect(params: {
  readonly labelHeight: number;
  readonly nudge: number;
  readonly placement: CommentMarkerPlacement;
  readonly targetRect: DOMRect;
  readonly viewportHeight: number;
  readonly viewportWidth: number;
}): CommentMarkerRect {
  const targetCenterX = params.targetRect.left + params.targetRect.width / 2;
  const targetCenterY = params.targetRect.top + params.targetRect.height / 2;
  const horizontalWidth =
    FRAME_COMMENT_CONNECTOR_GAP + FRAME_COMMENT_LABEL_MAX_WIDTH;
  const verticalHeight = FRAME_COMMENT_CONNECTOR_GAP + params.labelHeight;

  switch (params.placement) {
    case "right": {
      return commentMarkerRect({
        height: params.labelHeight,
        left: params.targetRect.right,
        top: clamp(
          targetCenterY - params.labelHeight / 2 + params.nudge,
          FRAME_COMMENT_VIEWPORT_PADDING,
          params.viewportHeight -
            FRAME_COMMENT_VIEWPORT_PADDING -
            params.labelHeight,
        ),
        width: horizontalWidth,
      });
    }
    case "bottom": {
      return commentMarkerRect({
        height: verticalHeight,
        left: clamp(
          targetCenterX - FRAME_COMMENT_LABEL_MAX_WIDTH / 2 + params.nudge,
          FRAME_COMMENT_VIEWPORT_PADDING,
          params.viewportWidth -
            FRAME_COMMENT_VIEWPORT_PADDING -
            FRAME_COMMENT_LABEL_MAX_WIDTH,
        ),
        top: params.targetRect.bottom,
        width: FRAME_COMMENT_LABEL_MAX_WIDTH,
      });
    }
    case "left": {
      return commentMarkerRect({
        height: params.labelHeight,
        left: params.targetRect.left - horizontalWidth,
        top: clamp(
          targetCenterY - params.labelHeight / 2 + params.nudge,
          FRAME_COMMENT_VIEWPORT_PADDING,
          params.viewportHeight -
            FRAME_COMMENT_VIEWPORT_PADDING -
            params.labelHeight,
        ),
        width: horizontalWidth,
      });
    }
    case "top": {
      return commentMarkerRect({
        height: verticalHeight,
        left: clamp(
          targetCenterX - FRAME_COMMENT_LABEL_MAX_WIDTH / 2 + params.nudge,
          FRAME_COMMENT_VIEWPORT_PADDING,
          params.viewportWidth -
            FRAME_COMMENT_VIEWPORT_PADDING -
            FRAME_COMMENT_LABEL_MAX_WIDTH,
        ),
        top: params.targetRect.top - verticalHeight,
        width: FRAME_COMMENT_LABEL_MAX_WIDTH,
      });
    }
  }
}

function markerPlacementHasGap(params: {
  readonly labelHeight: number;
  readonly placement: CommentMarkerPlacement;
  readonly targetRect: DOMRect;
  readonly viewportHeight: number;
  readonly viewportWidth: number;
}): boolean {
  switch (params.placement) {
    case "right": {
      return (
        params.viewportWidth - params.targetRect.right >=
        FRAME_COMMENT_CONNECTOR_GAP +
          FRAME_COMMENT_LABEL_MAX_WIDTH +
          FRAME_COMMENT_VIEWPORT_PADDING
      );
    }
    case "bottom": {
      return (
        params.viewportHeight - params.targetRect.bottom >=
        FRAME_COMMENT_CONNECTOR_GAP +
          params.labelHeight +
          FRAME_COMMENT_VIEWPORT_PADDING
      );
    }
    case "left": {
      return (
        params.targetRect.left >=
        FRAME_COMMENT_CONNECTOR_GAP +
          FRAME_COMMENT_LABEL_MAX_WIDTH +
          FRAME_COMMENT_VIEWPORT_PADDING
      );
    }
    case "top": {
      return (
        params.targetRect.top >=
        FRAME_COMMENT_CONNECTOR_GAP +
          params.labelHeight +
          FRAME_COMMENT_VIEWPORT_PADDING
      );
    }
  }
}

function clampedMarkerRect(params: {
  readonly rect: CommentMarkerRect;
  readonly viewportHeight: number;
  readonly viewportWidth: number;
}): CommentMarkerRect {
  return commentMarkerRect({
    height: params.rect.height,
    left: clamp(
      params.rect.left,
      FRAME_COMMENT_VIEWPORT_PADDING,
      params.viewportWidth - FRAME_COMMENT_VIEWPORT_PADDING - params.rect.width,
    ),
    top: clamp(
      params.rect.top,
      FRAME_COMMENT_VIEWPORT_PADDING,
      params.viewportHeight -
        FRAME_COMMENT_VIEWPORT_PADDING -
        params.rect.height,
    ),
    width: params.rect.width,
  });
}

function commentMarkerPosition(params: {
  readonly doc: Document;
  readonly labelHeight: number;
  readonly occupiedRects: readonly CommentMarkerRect[];
  readonly target: Element;
}): CommentMarkerPosition {
  const targetRect = params.target.getBoundingClientRect();
  const viewportWidth = params.doc.documentElement.clientWidth || 320;
  const viewportHeight = params.doc.documentElement.clientHeight || 240;
  const placements: readonly CommentMarkerPlacement[] = [
    "right",
    "bottom",
    "left",
    "top",
  ];
  let fallback: CommentMarkerPosition | null = null;

  for (const placement of placements) {
    if (
      !markerPlacementHasGap({
        labelHeight: params.labelHeight,
        placement,
        targetRect,
        viewportHeight,
        viewportWidth,
      })
    ) {
      continue;
    }

    for (const nudgeStep of FRAME_COMMENT_NUDGE_STEPS) {
      const rect = markerCandidateRect({
        labelHeight: params.labelHeight,
        nudge: nudgeStep * FRAME_COMMENT_NUDGE_STEP,
        placement,
        targetRect,
        viewportHeight,
        viewportWidth,
      });
      if (!fallback) {
        fallback = { placement, rect };
      }
      if (!commentMarkerCollides(rect, params.occupiedRects)) {
        return { placement, rect };
      }
    }
  }

  for (const placement of placements) {
    for (const nudgeStep of FRAME_COMMENT_NUDGE_STEPS) {
      const rect = clampedMarkerRect({
        rect: markerCandidateRect({
          labelHeight: params.labelHeight,
          nudge: nudgeStep * FRAME_COMMENT_NUDGE_STEP,
          placement,
          targetRect,
          viewportHeight,
          viewportWidth,
        }),
        viewportHeight,
        viewportWidth,
      });
      if (!fallback) {
        fallback = { placement, rect };
      }
      if (!commentMarkerCollides(rect, params.occupiedRects)) {
        return { placement, rect };
      }
    }
  }

  return (
    fallback ?? {
      placement: "right",
      rect: commentMarkerRect({
        height: params.labelHeight,
        left: FRAME_COMMENT_VIEWPORT_PADDING,
        top: FRAME_COMMENT_VIEWPORT_PADDING,
        width: FRAME_COMMENT_CONNECTOR_GAP + FRAME_COMMENT_LABEL_MAX_WIDTH,
      }),
    }
  );
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

function styleCommentMarkerLabel(label: HTMLElement): void {
  label.dataset.testid = "html-dom-comment-tag";
  label.style.position = "absolute";
  label.style.display = "flex";
  label.style.alignItems = "center";
  label.style.boxSizing = "border-box";
  label.style.maxWidth = `${FRAME_COMMENT_LABEL_MAX_WIDTH}px`;
  label.style.width = `${FRAME_COMMENT_LABEL_MAX_WIDTH}px`;
  label.style.height = `${FRAME_COMMENT_LABEL_HEIGHT}px`;
  label.style.padding = "8px 14px";
  label.style.borderRadius = "18px";
  label.style.background = "rgb(37, 99, 235)";
  label.style.border = "0";
  label.style.color = "white";
  label.style.cursor = "pointer";
  label.style.fontFamily =
    "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  label.style.fontSize = "14px";
  label.style.fontWeight = "600";
  label.style.lineHeight = `${FRAME_COMMENT_LABEL_LINE_HEIGHT}px`;
  label.style.overflow = "hidden";
  label.style.boxShadow = "0 6px 16px rgba(15, 23, 42, 0.18)";
  label.style.pointerEvents = "auto";
}

function styleCommentMarkerLabelText(labelText: HTMLElement): void {
  labelText.dataset.testid = "html-dom-comment-tag-text";
  labelText.style.display = "-webkit-box";
  labelText.style.width = "100%";
  labelText.style.lineHeight = `${FRAME_COMMENT_LABEL_LINE_HEIGHT}px`;
  labelText.style.whiteSpace = "normal";
  labelText.style.overflow = "hidden";
  labelText.style.overflowWrap = "anywhere";
  labelText.style.setProperty("-webkit-box-orient", "vertical");
  labelText.style.setProperty(
    "-webkit-line-clamp",
    String(FRAME_COMMENT_LABEL_MAX_LINES),
  );
}

function styleCommentMarkerDot(dot: HTMLElement): void {
  dot.setAttribute("aria-hidden", "true");
  dot.style.position = "absolute";
  dot.style.width = `${FRAME_COMMENT_DOT_SIZE}px`;
  dot.style.height = `${FRAME_COMMENT_DOT_SIZE}px`;
  dot.style.borderRadius = "999px";
  dot.style.background = "rgb(37, 99, 235)";
  dot.style.pointerEvents = "none";
}

function styleCommentMarkerLeader(leader: HTMLElement): void {
  leader.setAttribute("aria-hidden", "true");
  leader.style.position = "absolute";
  leader.style.pointerEvents = "none";
}

function styleCommentMarkerDeleteButton(params: {
  readonly button: HTMLElement;
  readonly commentId: string;
}): void {
  params.button.dataset.testid = "html-dom-comment-delete";
  params.button.setAttribute(HTML_DOM_COMMENT_DELETE_ATTR, params.commentId);
  params.button.setAttribute("aria-label", "Delete comment");
  params.button.textContent = "x";
  params.button.style.position = "absolute";
  params.button.style.display = "inline-flex";
  params.button.style.alignItems = "center";
  params.button.style.justifyContent = "center";
  params.button.style.width = "18px";
  params.button.style.height = "18px";
  params.button.style.border = "1px solid rgb(37, 99, 235)";
  params.button.style.borderRadius = "999px";
  params.button.style.background = "white";
  params.button.style.color = "rgb(37, 99, 235)";
  params.button.style.cursor = "pointer";
  params.button.style.fontFamily =
    "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  params.button.style.fontSize = "13px";
  params.button.style.fontWeight = "700";
  params.button.style.lineHeight = "1";
  params.button.style.opacity = "0";
  params.button.style.padding = "0";
  params.button.style.pointerEvents = "none";
  params.button.style.boxShadow = "0 2px 6px rgba(15, 23, 42, 0.18)";
  params.button.style.transition = "opacity 120ms ease, box-shadow 120ms ease";
}

function positionCommentMarkerParts(params: {
  readonly deleteButton: HTMLElement;
  readonly dot: HTMLElement;
  readonly label: HTMLElement;
  readonly leader: HTMLElement;
  readonly placement: CommentMarkerPlacement;
  readonly rect: CommentMarkerRect;
}): void {
  const dotCenterOffset = FRAME_COMMENT_DOT_SIZE / 2;
  const labelHeight =
    params.placement === "bottom" || params.placement === "top"
      ? params.rect.height - FRAME_COMMENT_CONNECTOR_GAP
      : params.rect.height;
  const labelCenterOffset = labelHeight / 2;
  const markerCenterY = params.rect.height / 2;
  const markerCenterX = params.rect.width / 2;
  const horizontalLeaderLeft = FRAME_COMMENT_DOT_SIZE + 4;
  const horizontalLeaderWidth =
    FRAME_COMMENT_CONNECTOR_GAP - FRAME_COMMENT_DOT_SIZE - 8;
  const verticalLeaderTop = FRAME_COMMENT_DOT_SIZE + 4;
  const verticalLeaderHeight =
    FRAME_COMMENT_CONNECTOR_GAP - FRAME_COMMENT_DOT_SIZE - 8;

  switch (params.placement) {
    case "right": {
      params.dot.style.left = "0";
      params.dot.style.top = `${markerCenterY - dotCenterOffset}px`;
      params.leader.style.left = `${horizontalLeaderLeft}px`;
      params.leader.style.top = `${markerCenterY - 1}px`;
      params.leader.style.width = `${horizontalLeaderWidth}px`;
      params.leader.style.borderTop = "2px dashed rgb(37, 99, 235)";
      params.label.style.left = `${FRAME_COMMENT_CONNECTOR_GAP}px`;
      params.label.style.top = `${markerCenterY - labelCenterOffset}px`;
      params.deleteButton.style.left = `${
        FRAME_COMMENT_CONNECTOR_GAP + FRAME_COMMENT_LABEL_MAX_WIDTH - 10
      }px`;
      params.deleteButton.style.top = `${
        markerCenterY - labelCenterOffset - 8
      }px`;
      break;
    }
    case "bottom": {
      params.dot.style.left = `${markerCenterX - dotCenterOffset}px`;
      params.dot.style.top = "0";
      params.leader.style.left = `${markerCenterX - 1}px`;
      params.leader.style.top = `${verticalLeaderTop}px`;
      params.leader.style.height = `${verticalLeaderHeight}px`;
      params.leader.style.borderLeft = "2px dashed rgb(37, 99, 235)";
      params.label.style.left = "0";
      params.label.style.top = `${FRAME_COMMENT_CONNECTOR_GAP}px`;
      params.deleteButton.style.left = `${
        FRAME_COMMENT_LABEL_MAX_WIDTH - 10
      }px`;
      params.deleteButton.style.top = `${FRAME_COMMENT_CONNECTOR_GAP - 8}px`;
      break;
    }
    case "left": {
      params.label.style.left = "0";
      params.label.style.top = `${markerCenterY - labelCenterOffset}px`;
      params.leader.style.left = `${FRAME_COMMENT_LABEL_MAX_WIDTH + 4}px`;
      params.leader.style.top = `${markerCenterY - 1}px`;
      params.leader.style.width = `${horizontalLeaderWidth}px`;
      params.leader.style.borderTop = "2px dashed rgb(37, 99, 235)";
      params.dot.style.left = `${params.rect.width - FRAME_COMMENT_DOT_SIZE}px`;
      params.dot.style.top = `${markerCenterY - dotCenterOffset}px`;
      params.deleteButton.style.left = `${
        FRAME_COMMENT_LABEL_MAX_WIDTH - 10
      }px`;
      params.deleteButton.style.top = `${
        markerCenterY - labelCenterOffset - 8
      }px`;
      break;
    }
    case "top": {
      params.label.style.left = "0";
      params.label.style.top = "0";
      params.leader.style.left = `${markerCenterX - 1}px`;
      params.leader.style.top = `${labelHeight + 4}px`;
      params.leader.style.height = `${verticalLeaderHeight}px`;
      params.leader.style.borderLeft = "2px dashed rgb(37, 99, 235)";
      params.dot.style.left = `${markerCenterX - dotCenterOffset}px`;
      params.dot.style.top = `${params.rect.height - FRAME_COMMENT_DOT_SIZE}px`;
      params.deleteButton.style.left = `${
        FRAME_COMMENT_LABEL_MAX_WIDTH - 10
      }px`;
      params.deleteButton.style.top = "-8px";
      break;
    }
  }
}

function createFrameCommentMarker(params: {
  readonly comment: HtmlDomEditComment;
  readonly doc: Document;
  readonly nodeId: string;
  readonly position: CommentMarkerPosition;
}): HTMLElement {
  const marker = params.doc.createElement("div");
  marker.setAttribute(HTML_DOM_EDIT_OVERLAY_ATTR, "");
  marker.setAttribute(HTML_DOM_COMMENT_MARKER_TARGET_ATTR, params.nodeId);
  marker.setAttribute(
    FRAME_COMMENT_MARKER_PLACEMENT_ATTR,
    params.position.placement,
  );
  marker.dataset.testid = "html-dom-comment-marker";
  marker.setAttribute("aria-label", `Comment: ${params.comment.comment}`);
  marker.style.position = "absolute";
  marker.style.left = `${params.position.rect.left}px`;
  marker.style.top = `${params.position.rect.top}px`;
  marker.style.width = `${params.position.rect.width}px`;
  marker.style.height = `${params.position.rect.height}px`;
  marker.style.border = "0";
  marker.style.borderRadius = "0";
  marker.style.background = "transparent";
  marker.style.cursor = "pointer";
  marker.style.pointerEvents = "auto";
  marker.style.padding = "0";
  marker.style.margin = "0";
  marker.style.overflow = "visible";

  const dot = params.doc.createElement("span");
  const leader = params.doc.createElement("span");
  const label = params.doc.createElement("button");
  const labelText = params.doc.createElement("span");
  const deleteButton = params.doc.createElement("button");
  label.type = "button";
  deleteButton.type = "button";
  dot.dataset.testid = "html-dom-comment-anchor";
  leader.dataset.testid = "html-dom-comment-leader";
  labelText.textContent = params.comment.comment;
  styleCommentMarkerDot(dot);
  styleCommentMarkerLeader(leader);
  styleCommentMarkerLabel(label);
  styleCommentMarkerLabelText(labelText);
  styleCommentMarkerDeleteButton({
    button: deleteButton,
    commentId: params.comment.id,
  });
  label.append(labelText);
  positionCommentMarkerParts({
    deleteButton,
    dot,
    label,
    leader,
    placement: params.position.placement,
    rect: params.position.rect,
  });
  marker.append(dot, leader, label, deleteButton);
  return marker;
}

function syncFrameCommentMarkers(
  doc: Document | null | undefined,
  comments: readonly HtmlDomEditComment[],
  visibleCommentId?: string | null,
  hideAll = false,
): void {
  if (!doc) {
    return;
  }

  if (comments.length === 0 || hideAll) {
    removeFrameCommentLayer(doc);
    return;
  }

  const layer = ensureFrameCommentLayer(doc);
  layer.replaceChildren();
  const occupiedRects: CommentMarkerRect[] = [];
  const usedNodeIds = new Set<string>();
  const commentsWithTargets = comments
    .filter((comment) => {
      return !visibleCommentId || comment.id === visibleCommentId;
    })
    .map((comment) => {
      const nodeId = comment.targetNodeIds[0];
      const target = nodeId ? doc.querySelector(nodeSelector(nodeId)) : null;
      return nodeId && target ? { comment, nodeId, target } : null;
    })
    .filter(
      (
        entry,
      ): entry is {
        readonly comment: HtmlDomEditComment;
        readonly nodeId: string;
        readonly target: Element;
      } => {
        return entry !== null;
      },
    )
    .filter((entry) => {
      return targetIntersectsViewport({
        doc,
        target: entry.target,
      });
    })
    .sort((first, second) => {
      const firstRect = first.target.getBoundingClientRect();
      const secondRect = second.target.getBoundingClientRect();
      return firstRect.top - secondRect.top || firstRect.left - secondRect.left;
    });

  for (const { comment, nodeId, target } of commentsWithTargets) {
    if (usedNodeIds.has(nodeId)) {
      continue;
    }
    usedNodeIds.add(nodeId);
    const position = commentMarkerPosition({
      doc,
      labelHeight: FRAME_COMMENT_LABEL_HEIGHT,
      occupiedRects,
      target,
    });
    occupiedRects.push(position.rect);
    layer.append(
      createFrameCommentMarker({
        comment,
        doc,
        nodeId,
        position,
      }),
    );
  }
}

function shouldHideCommittedCommentMarkers(params: {
  readonly comments: readonly HtmlDomEditComment[];
  readonly editingCommentId: string | null;
  readonly selectedNodeIds: readonly string[];
}): boolean {
  return (
    params.editingCommentId === null &&
    params.selectedNodeIds.length > 0 &&
    !hasCommentForSelectedNodes({
      comments: params.comments,
      selectedNodeIds: params.selectedNodeIds,
    })
  );
}

export const deleteHtmlDomComment$ = command(
  ({ get, set }, commentId: string) => {
    const comments = get(internalComments$);
    const deletedComment = comments.find((comment) => {
      return comment.id === commentId;
    });
    if (!deletedComment) {
      return;
    }

    const nextComments = comments.filter((comment) => {
      return comment.id !== commentId;
    });
    const editingCommentId = get(internalEditingCommentId$);
    const selectedNodeIds = get(internalSelectedNodeIds$);
    const shouldResetDraft =
      editingCommentId === commentId ||
      deletedComment.targetNodeIds.some((nodeId) => {
        return selectedNodeIds.includes(nodeId);
      });
    const doc = currentFrameDocument(get(internalIframeElement$));

    set(internalComments$, nextComments);
    set(internalPreparedPayload$, null);

    if (shouldResetDraft) {
      set(internalCommentText$, "");
      set(internalSelectedNodeIds$, []);
      set(internalCommentPopoverAnchor$, null);
      set(internalEditingCommentId$, null);
      syncFrameEditState(doc, {
        hoveredNodeId: get(internalHoveredNodeId$),
        selectedNodeIds: [],
      });
      syncFrameCommentMarkers(doc, nextComments);
      return;
    }

    syncFrameCommentMarkers(
      doc,
      nextComments,
      editingCommentId,
      shouldHideCommittedCommentMarkers({
        comments: nextComments,
        editingCommentId,
        selectedNodeIds,
      }),
    );
  },
);

function flashFrameCommentTarget(element: Element): void {
  element.removeAttribute(HTML_DOM_COMMENT_FLASH_ATTR);
  element.getBoundingClientRect();
  element.setAttribute(HTML_DOM_COMMENT_FLASH_ATTR, "true");
  element.ownerDocument.defaultView?.setTimeout(() => {
    element.removeAttribute(HTML_DOM_COMMENT_FLASH_ATTR);
  }, 900);
}

export const focusHtmlDomComment$ = command(
  ({ get, set }, commentId: string) => {
    const comment = get(internalComments$).find((candidate) => {
      return candidate.id === commentId;
    });
    const nodeId = comment?.targetNodeIds[0];
    const doc = currentFrameDocument(get(internalIframeElement$));
    const target = nodeId ? doc?.querySelector(nodeSelector(nodeId)) : null;
    if (!nodeId || !doc || !target) {
      return;
    }

    set(internalHoveredNodeId$, null);
    set(internalEditingCommentId$, null);
    set(internalCommentPopoverAnchor$, null);
    set(internalSelectedNodeIds$, [nodeId]);
    syncFrameEditState(doc, {
      hoveredNodeId: null,
      selectedNodeIds: [nodeId],
    });
    syncFrameCommentMarkers(doc, get(internalComments$));
    target.scrollIntoView?.({
      behavior: "smooth",
      block: "center",
      inline: "center",
    });
    flashFrameCommentTarget(target);
  },
);

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
  readonly deleteComment: (commentId: string) => void;
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
    if (closestCommentDeleteButton(event.target)) {
      return;
    }
    const markerNodeId = closestCommentMarker(event.target)?.getAttribute(
      HTML_DOM_COMMENT_MARKER_TARGET_ATTR,
    );
    if (markerNodeId) {
      params.setHoveredNodeId(markerNodeId);
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
    const deleteCommentId = closestCommentDeleteButton(
      event.target,
    )?.getAttribute(HTML_DOM_COMMENT_DELETE_ATTR);
    if (deleteCommentId) {
      event.preventDefault();
      event.stopPropagation();
      params.deleteComment(deleteCommentId);
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
      const comments = get(internalComments$);
      const editingCommentId = get(internalEditingCommentId$);
      const selectedNodeIds = get(internalSelectedNodeIds$);
      syncFrameCommentMarkers(
        doc,
        comments,
        editingCommentId,
        shouldHideCommittedCommentMarkers({
          comments,
          editingCommentId,
          selectedNodeIds,
        }),
      );
    };
    const view = doc.defaultView;
    view?.addEventListener("scroll", syncMarkers, true);
    view?.addEventListener("resize", syncMarkers);

    const eventCleanup = bindFrameCommentEvents({
      deleteComment: (commentId) => {
        set(deleteHtmlDomComment$, commentId);
      },
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
        if (get(internalEditingCommentId$) === value) {
          return;
        }
        const comments = get(internalComments$);
        const selectedNodeIds = get(internalSelectedNodeIds$);
        set(internalEditingCommentId$, value);
        syncFrameCommentMarkers(
          doc,
          comments,
          value,
          shouldHideCommittedCommentMarkers({
            comments,
            editingCommentId: value,
            selectedNodeIds,
          }),
        );
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
        const comments = get(internalComments$);
        const editingCommentId = get(internalEditingCommentId$);
        const previousSelectedNodeIds = get(internalSelectedNodeIds$);
        const wasHidingMarkers = shouldHideCommittedCommentMarkers({
          comments,
          editingCommentId,
          selectedNodeIds: previousSelectedNodeIds,
        });
        const shouldHideMarkers = shouldHideCommittedCommentMarkers({
          comments,
          editingCommentId,
          selectedNodeIds: value,
        });
        set(internalSelectedNodeIds$, value);
        syncFrameEditState(doc, {
          hoveredNodeId: get(internalHoveredNodeId$),
          selectedNodeIds: value,
        });
        if (wasHidingMarkers !== shouldHideMarkers) {
          syncFrameCommentMarkers(
            doc,
            comments,
            editingCommentId,
            shouldHideMarkers,
          );
        }
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
  syncFrameCommentMarkers(
    currentFrameDocument(get(internalIframeElement$)),
    get(internalComments$),
    currentComment.id,
  );
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
  syncFrameCommentMarkers(
    currentFrameDocument(get(internalIframeElement$)),
    get(internalComments$),
  );
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
