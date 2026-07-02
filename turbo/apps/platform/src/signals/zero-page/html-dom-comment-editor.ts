import { createElement } from "react";
import { IconPointer2 } from "@tabler/icons-react";
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

export type HtmlDomStyleProperty = "backgroundColor" | "color";
export type HtmlDomImageLayout = "contain" | "cover" | "fill";
export type HtmlDomImagePendingAction = "link" | "upload";

type HtmlDomInlineStyleProperty = HtmlDomStyleProperty | "objectFit";

export interface HtmlDomSelectedImage {
  readonly layout: HtmlDomImageLayout;
  readonly renderedSize: string | null;
  readonly resolvedSrc: string;
  readonly src: string;
}

export interface HtmlDomSelectedStyle {
  readonly backgroundColor: string;
  readonly color: string;
}

export interface HtmlDomColorPopoverOffset {
  readonly left: number;
  readonly top: number;
}

type HtmlDomStyleEdits = Partial<Record<HtmlDomInlineStyleProperty, string>>;

type HtmlDomOriginalInlineStyles = Partial<
  Record<HtmlDomInlineStyleProperty, string>
>;
type FrameStyleElement = HTMLElement | SVGElement;

interface HtmlDomImageEdits {
  readonly src?: string;
}

export interface HtmlDomCommentEditorModel {
  readonly activeColorPanelProperty: HtmlDomStyleProperty | null;
  readonly canApplyStyleEdits: boolean;
  readonly canAddComment: boolean;
  readonly canEditSelectedStyle: boolean;
  readonly canSend: boolean;
  readonly colorPopoverOffset: HtmlDomColorPopoverOffset;
  readonly commentsOpen: boolean;
  readonly commentText: string;
  readonly commentPopoverAnchor: CommentPopoverAnchor | null;
  readonly comments: readonly HtmlDomEditComment[];
  readonly currentComment: HtmlDomEditComment | null;
  readonly editableStyleProperties: readonly HtmlDomStyleProperty[];
  readonly editingCommentId: string | null;
  readonly imageBusy: boolean;
  readonly imageLinkOpen: boolean;
  readonly imageLinkValue: string;
  readonly imagePendingAction: HtmlDomImagePendingAction | null;
  readonly loadState: EditorLoadState;
  readonly popoverTextAreaKey: string;
  readonly prepared: boolean;
  readonly selectedImage: HtmlDomSelectedImage | null;
  readonly selectedStyle: HtmlDomSelectedStyle;
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
  readonly onGenerated?: (draft: HtmlDomEditDraft) => void | Promise<void>;
  readonly onPrepared?: (payload: HtmlDomEditPayload) => Promise<void>;
  readonly onStarted?: () => void;
}

interface ApplyHtmlDomStyleEditsParams {
  readonly onApplied?: (html: string) => Promise<void>;
  readonly onFailed?: () => void;
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
const HTML_DOM_EDIT_BOX_LAYER_ID = "vm0-html-edit-box-layer";
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
  createElement(IconPointer2, {
    "aria-hidden": "true",
    color: "#2563eb",
    size: 20,
    stroke: 2.6,
  }),
);
const FRAME_NAVIGATION_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  FRAME_NAVIGATION_CURSOR_SVG,
)}") 3 3, pointer`;
const IMAGE_UPLOAD_CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> =
  {
    avif: "image/avif",
    bmp: "image/bmp",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
  };
const SUPPORTED_IMAGE_UPLOAD_CONTENT_TYPES = [
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
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
const internalActiveColorPanelProperty$ = state<HtmlDomStyleProperty | null>(
  null,
);
const internalColorPopoverOffset$ = state<HtmlDomColorPopoverOffset>({
  left: 0,
  top: 0,
});
const internalStyleEditsByNodeId$ = state<
  Readonly<Record<string, HtmlDomStyleEdits>>
>({});
const internalOriginalStylesByNodeId$ = state<
  Readonly<Record<string, HtmlDomOriginalInlineStyles>>
>({});
const internalImageEditsByNodeId$ = state<
  Readonly<Record<string, HtmlDomImageEdits>>
>({});
const internalImageBusy$ = state(false);
const internalImageLinkOpen$ = state(false);
const internalImageLinkValue$ = state("");
const internalImagePendingAction$ = state<HtmlDomImagePendingAction | null>(
  null,
);
const resetHtmlDomEditRequestSignal$ = resetSignal();
const resetHtmlDomImageEditSignal$ = resetSignal();

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

function inferImageUploadContentType(file: File): string | null {
  const explicitType = file.type.split(";")[0]?.trim().toLowerCase();
  if (
    SUPPORTED_IMAGE_UPLOAD_CONTENT_TYPES.includes(
      explicitType as (typeof SUPPORTED_IMAGE_UPLOAD_CONTENT_TYPES)[number],
    )
  ) {
    return explicitType;
  }
  const extension = file.name.split(".").pop()?.toLowerCase();
  return extension
    ? (IMAGE_UPLOAD_CONTENT_TYPE_BY_EXTENSION[extension] ?? null)
    : null;
}

async function uploadHtmlDomImage(params: {
  readonly createClient: ZeroClientFactory;
  readonly file: File;
  readonly signal: AbortSignal;
}): Promise<string> {
  const contentType = inferImageUploadContentType(params.file);
  if (!contentType) {
    throw new Error("Choose a PNG, JPEG, GIF, WebP, AVIF, or BMP image");
  }

  const client = params.createClient(zeroUploadsContract);
  const prepared = await accept(
    client.prepare({
      body: {
        filename: params.file.name,
        contentType,
        size: params.file.size,
      },
      fetchOptions: { signal: params.signal },
    }),
    [200],
  );
  params.signal.throwIfAborted();

  const putResponse = await fetch(prepared.body.uploadUrl, {
    method: "PUT",
    body: params.file,
    headers: { "content-type": prepared.body.contentType },
    signal: params.signal,
  });
  params.signal.throwIfAborted();

  if (!putResponse.ok) {
    throw new Error(
      `storage returned ${putResponse.status} ${putResponse.statusText}`,
    );
  }

  const completed = await accept(
    client.complete({
      body: {
        id: prepared.body.id,
        contentType: prepared.body.contentType,
      },
      fetchOptions: { signal: params.signal },
    }),
    [200],
  );
  params.signal.throwIfAborted();

  return completed.body.url;
}

function normalizeImageLinkUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (!URL.canParse(trimmed)) {
    return null;
  }

  const parsed = new URL(trimmed);
  return parsed.protocol === "http:" || parsed.protocol === "https:"
    ? parsed.toString()
    : null;
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

function isElementLike(value: EventTarget | null): value is Element {
  return (
    value !== null && typeof value === "object" && "ownerDocument" in value
  );
}

function isMousePointEvent(event: Event): event is MouseEvent {
  return "clientX" in event && "clientY" in event;
}

function isFrameHtmlElement(
  element: Element | null | undefined,
): element is HTMLElement {
  if (!element) {
    return false;
  }
  const FrameHTMLElement = element.ownerDocument.defaultView?.HTMLElement;
  return FrameHTMLElement
    ? element instanceof FrameHTMLElement
    : element instanceof HTMLElement;
}

function isFrameSvgElement(
  element: Element | null | undefined,
): element is SVGElement {
  if (!element) {
    return false;
  }
  const FrameSVGElement = element.ownerDocument.defaultView?.SVGElement;
  return FrameSVGElement
    ? element instanceof FrameSVGElement
    : typeof SVGElement !== "undefined" && element instanceof SVGElement;
}

function isFrameStyleElement(
  element: Element | null | undefined,
): element is FrameStyleElement {
  return isFrameHtmlElement(element) || isFrameSvgElement(element);
}

function isFrameImageElement(
  element: Element | null | undefined,
): element is HTMLImageElement {
  if (!element) {
    return false;
  }
  const FrameHTMLImageElement =
    element.ownerDocument.defaultView?.HTMLImageElement;
  return FrameHTMLImageElement
    ? element instanceof FrameHTMLImageElement
    : element instanceof HTMLImageElement;
}

const IMAGE_WRAPPER_SELECTOR = ["a[href]", "figure", "picture"].join(",");

function descendantImageForImageWrapper(
  element: Element | null | undefined,
): HTMLImageElement | null {
  if (!element?.matches(IMAGE_WRAPPER_SELECTOR)) {
    return null;
  }

  const images = Array.from(element.querySelectorAll("img")).filter(
    isFrameImageElement,
  );
  return images.length === 1 ? images[0] : null;
}

function imageElementForCommentCandidate(
  element: Element | null | undefined,
): HTMLImageElement | null {
  return isFrameImageElement(element)
    ? element
    : descendantImageForImageWrapper(element);
}

function selectedImageElementForNodes(params: {
  readonly doc: Document | null;
  readonly selectedNodeIds: readonly string[];
}): { readonly element: HTMLImageElement; readonly nodeId: string } | null {
  const nodeId = params.selectedNodeIds[0];
  if (!nodeId) {
    return null;
  }
  const element = params.doc?.querySelector(nodeSelector(nodeId));
  if (isFrameImageElement(element)) {
    return { element, nodeId };
  }

  const descendantImage = imageElementForCommentCandidate(element);
  const descendantNodeId = descendantImage?.getAttribute(HTML_DOM_NODE_ID_ATTR);
  return descendantImage && descendantNodeId
    ? { element: descendantImage, nodeId: descendantNodeId }
    : null;
}

function imageLayoutForElement(element: HTMLImageElement): HtmlDomImageLayout {
  const view = element.ownerDocument.defaultView;
  const objectFit =
    element.style.getPropertyValue("object-fit") ||
    view?.getComputedStyle(element).getPropertyValue("object-fit");
  switch (objectFit?.trim()) {
    case "contain":
    case "cover":
    case "fill": {
      return objectFit.trim() as HtmlDomImageLayout;
    }
    default: {
      return "fill";
    }
  }
}

function imageRenderedSize(element: HTMLImageElement): string | null {
  const rect = element.getBoundingClientRect();
  const width = Math.round(rect.width || element.width || element.naturalWidth);
  const height = Math.round(
    rect.height || element.height || element.naturalHeight,
  );
  return width > 0 && height > 0 ? `${width} x ${height}` : null;
}

function selectedImageForNodes(params: {
  readonly doc: Document | null;
  readonly selectedNodeIds: readonly string[];
}): HtmlDomSelectedImage | null {
  const selected = selectedImageElementForNodes(params);
  if (!selected) {
    return null;
  }
  const src = selected.element.getAttribute("src") ?? "";
  return {
    layout: imageLayoutForElement(selected.element),
    renderedSize: imageRenderedSize(selected.element),
    resolvedSrc: selected.element.currentSrc || selected.element.src || src,
    src,
  };
}

function smallestCommentNodeAtPoint(event: MouseEvent): Element | null {
  const doc =
    event.view?.document ??
    (isElementLike(event.target) ? event.target.ownerDocument : null);
  const elements = doc?.elementsFromPoint?.(event.clientX, event.clientY) ?? [];
  const candidates = elements
    .map((element) => {
      return element.closest(`[${HTML_DOM_NODE_ID_ATTR}]`);
    })
    .filter((element): element is Element => {
      return element !== null;
    });
  const uniqueCandidates = Array.from(new Set(candidates));
  const imageCandidate = uniqueCandidates.find(isFrameImageElement);
  if (imageCandidate) {
    return imageCandidate;
  }

  return (
    uniqueCandidates.sort((first, second) => {
      const firstRect = first.getBoundingClientRect();
      const secondRect = second.getBoundingClientRect();
      return (
        firstRect.width * firstRect.height -
        secondRect.width * secondRect.height
      );
    })[0] ?? null
  );
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

function removeFrameEditBoxLayer(doc: Document): void {
  doc.getElementById(HTML_DOM_EDIT_BOX_LAYER_ID)?.remove();
}

function ensureFrameEditBoxLayer(doc: Document): HTMLElement {
  let layer: HTMLElement | null = null;
  for (const candidate of Array.from(
    doc.querySelectorAll(`#${HTML_DOM_EDIT_BOX_LAYER_ID}`),
  )) {
    if (isFrameHtmlElement(candidate) && layer === null) {
      layer = candidate;
      continue;
    }
    candidate.remove();
  }

  if (layer) {
    return layer;
  }

  layer = doc.createElement("div");
  layer.id = HTML_DOM_EDIT_BOX_LAYER_ID;
  layer.setAttribute(HTML_DOM_EDIT_OVERLAY_ATTR, "");
  layer.setAttribute("aria-hidden", "true");
  layer.style.position = "fixed";
  layer.style.setProperty("inset", "0");
  layer.style.zIndex = "2147483646";
  layer.style.pointerEvents = "none";
  doc.body.append(layer);
  return layer;
}

function createFrameEditBox(params: {
  readonly element: HTMLElement;
  readonly kind: "hover" | "selected";
}): HTMLElement | null {
  const rect = params.element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  const doc = params.element.ownerDocument;
  const view = doc.defaultView;
  const computedStyle = view?.getComputedStyle(params.element);
  const box = doc.createElement("div");
  box.setAttribute(HTML_DOM_EDIT_OVERLAY_ATTR, "");
  box.dataset.testid =
    params.kind === "hover" ? "html-dom-hover-box" : "html-dom-selected-box";
  box.style.position = "absolute";
  box.style.left = `${rect.left}px`;
  box.style.top = `${rect.top}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
  box.style.boxSizing = "border-box";
  box.style.border =
    params.kind === "hover"
      ? "2px dashed rgba(37, 99, 235, 0.85)"
      : "2px solid rgb(37, 99, 235)";
  box.style.borderRadius = computedStyle?.borderRadius || "0";
  box.style.boxShadow =
    params.kind === "selected" ? "0 0 0 4px rgba(37, 99, 235, 0.16)" : "none";
  box.style.pointerEvents = "none";
  return box;
}

function syncFrameEditBoxes(
  doc: Document,
  params: {
    readonly hoveredNodeId: string | null;
    readonly selectedNodeIds: readonly string[];
  },
): void {
  const boxes: HTMLElement[] = [];
  const selectedNodeIds = new Set(params.selectedNodeIds);

  if (params.hoveredNodeId && !selectedNodeIds.has(params.hoveredNodeId)) {
    const hoveredElement = doc.querySelector(
      nodeSelector(params.hoveredNodeId),
    );
    if (isFrameImageElement(hoveredElement)) {
      const box = createFrameEditBox({
        element: hoveredElement,
        kind: "hover",
      });
      if (box) {
        boxes.push(box);
      }
    }
  }

  for (const nodeId of params.selectedNodeIds) {
    const selectedElement = doc.querySelector(nodeSelector(nodeId));
    if (!isFrameImageElement(selectedElement)) {
      continue;
    }
    const box = createFrameEditBox({
      element: selectedElement,
      kind: "selected",
    });
    if (box) {
      boxes.push(box);
    }
  }

  if (boxes.length === 0) {
    removeFrameEditBoxLayer(doc);
    return;
  }

  ensureFrameEditBoxLayer(doc).replaceChildren(...boxes);
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

  syncFrameEditBoxes(doc, params);
}

function isTrackableRunningFrameEditAnimation(animation: Animation): boolean {
  if (animation.playState !== "running") {
    return false;
  }

  const iterations = animation.effect?.getTiming().iterations;
  return iterations === undefined || Number.isFinite(iterations);
}

function hasTrackableRunningFrameEditAnimation(
  doc: Document,
  params: {
    readonly hoveredNodeId: string | null;
    readonly selectedNodeIds: readonly string[];
  },
): boolean {
  const nodeIds = [
    ...(params.hoveredNodeId ? [params.hoveredNodeId] : []),
    ...params.selectedNodeIds,
  ];
  return nodeIds.some((nodeId) => {
    const element = doc.querySelector(nodeSelector(nodeId));
    if (!isFrameImageElement(element)) {
      return false;
    }
    return (element.getAnimations?.() ?? []).some((animation) => {
      return isTrackableRunningFrameEditAnimation(animation);
    });
  });
}

function trackFrameEditState(params: {
  readonly doc: Document;
  readonly state: () => {
    readonly hoveredNodeId: string | null;
    readonly selectedNodeIds: readonly string[];
  };
}): void {
  const view = params.doc.defaultView;
  if (!view) {
    return;
  }

  let frameCount = 0;
  const tick = () => {
    const state = params.state();
    frameCount += 1;
    syncFrameEditState(params.doc, state);
    // Run two frames before relying on getAnimations() so newly-started CSS
    // transitions are visible after style/layout has settled.
    if (
      frameCount < 2 ||
      hasTrackableRunningFrameEditAnimation(params.doc, state)
    ) {
      view.requestAnimationFrame(tick);
    }
  };
  view.requestAnimationFrame(tick);
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
    img[${HTML_DOM_EDIT_HOVER_ATTR}="true"] {
      outline: none !important;
      box-shadow: none !important;
    }
    [${HTML_DOM_EDIT_SELECTED_ATTR}="true"] {
      outline: 2px solid rgb(37, 99, 235) !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.16) !important;
    }
    img[${HTML_DOM_EDIT_SELECTED_ATTR}="true"] {
      outline: none !important;
      box-shadow: none !important;
    }
    [${HTML_DOM_COMMENT_MARKER_TARGET_ATTR}]:hover [${HTML_DOM_COMMENT_DELETE_ATTR}],
    [${HTML_DOM_COMMENT_DELETE_ATTR}]:focus-visible {
      opacity: 1 !important;
      pointer-events: auto !important;
    }
    [${HTML_DOM_COMMENT_DELETE_ATTR}]:hover {
      background: rgba(255, 255, 255, 0.28) !important;
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

function isElementInsideFrameViewport(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  return (
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < view.innerHeight &&
    rect.left < view.innerWidth
  );
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

function hasStyleEdits(
  styleEditsByNodeId: Readonly<Record<string, HtmlDomStyleEdits>>,
): boolean {
  return Object.values(styleEditsByNodeId).some((edits) => {
    return Object.values(edits).some((value) => {
      return value !== undefined;
    });
  });
}

function hasImageEdits(
  imageEditsByNodeId: Readonly<Record<string, HtmlDomImageEdits>>,
): boolean {
  return Object.values(imageEditsByNodeId).some((edits) => {
    return edits.src !== undefined;
  });
}

function selectedStyleForNodes(params: {
  readonly doc: Document | null;
  readonly selectedNodeIds: readonly string[];
}): HtmlDomSelectedStyle {
  const firstNodeId = params.selectedNodeIds[0];
  const element = firstNodeId
    ? params.doc?.querySelector(nodeSelector(firstNodeId))
    : null;
  return {
    backgroundColor: isFrameStyleElement(element)
      ? elementBackgroundColor(element)
      : "#FFFFFF",
    color: isFrameStyleElement(element) ? elementTextColor(element) : "#111827",
  };
}

function editableStylePropertiesForSelectedNodes(params: {
  readonly doc: Document | null;
  readonly selectedNodeIds: readonly string[];
}): readonly HtmlDomStyleProperty[] {
  const properties: HtmlDomStyleProperty[] = [];
  if (
    canEditStylePropertyForSelectedNodes({
      ...params,
      property: "color",
    })
  ) {
    properties.push("color");
  }
  if (
    canEditStylePropertyForSelectedNodes({
      ...params,
      property: "backgroundColor",
    })
  ) {
    properties.push("backgroundColor");
  }
  return properties;
}

function canEditStylePropertyForSelectedNodes(params: {
  readonly doc: Document | null;
  readonly property: HtmlDomStyleProperty;
  readonly selectedNodeIds: readonly string[];
}): boolean {
  const firstNodeId = params.selectedNodeIds[0];
  const element = firstNodeId
    ? params.doc?.querySelector(nodeSelector(firstNodeId))
    : null;
  if (
    !isFrameStyleElement(element) ||
    isStyleControlUnsupportedTagName(element.tagName)
  ) {
    return false;
  }
  if (params.property === "backgroundColor") {
    return isFrameHtmlElement(element);
  }
  return editableTextColorTargets(element).length > 0;
}

function isStyleControlUnsupportedTagName(tagName: string): boolean {
  switch (tagName.toUpperCase()) {
    case "AUDIO":
    case "BR":
    case "CANVAS":
    case "EMBED":
    case "HR":
    case "IFRAME":
    case "IMG":
    case "OBJECT":
    case "PICTURE":
    case "SOURCE":
    case "TRACK":
    case "VIDEO": {
      return true;
    }
    default: {
      return false;
    }
  }
}

function elementTextColor(element: FrameStyleElement): string {
  const textTarget = editableTextColorTargets(element)[0] ?? element;
  const computedStyle =
    textTarget.ownerDocument.defaultView?.getComputedStyle(textTarget);
  if (isFrameSvgElement(textTarget)) {
    const fillColor = cssColorToHex(
      computedStyle?.getPropertyValue("fill") ||
        textTarget.style.getPropertyValue("fill") ||
        textTarget.getAttribute("fill") ||
        undefined,
      "",
      textTarget.ownerDocument,
    );
    if (fillColor) {
      return fillColor;
    }
  }

  return cssColorToHex(
    computedStyle?.getPropertyValue("color") ||
      textTarget.style.getPropertyValue("color"),
    "#111827",
    textTarget.ownerDocument,
  );
}

function editableTextColorTargets(
  element: FrameStyleElement,
): readonly FrameStyleElement[] {
  const candidates = [
    element,
    ...Array.from(element.querySelectorAll("*")),
  ].filter(isFrameStyleElement);
  return candidates.filter((candidate) => {
    return (
      !isStyleControlUnsupportedTagName(candidate.tagName) &&
      hasEditableTextColor(candidate)
    );
  });
}

function hasEditableTextColor(element: FrameStyleElement): boolean {
  if (isFrameSvgElement(element)) {
    return hasUsefulTextContent(element);
  }
  if (isTextControlElement(element)) {
    return true;
  }
  return hasDirectUsefulText(element);
}

function hasUsefulTextContent(element: Element): boolean {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim().length > 0;
}

function hasDirectUsefulText(element: Element): boolean {
  return Array.from(element.childNodes).some((node) => {
    return (
      node.nodeType === 3 &&
      (node.textContent ?? "").replace(/\s+/g, " ").trim().length > 0
    );
  });
}

function isTextControlElement(element: HTMLElement): boolean {
  switch (element.tagName.toUpperCase()) {
    case "BUTTON":
    case "INPUT":
    case "SELECT":
    case "TEXTAREA": {
      return true;
    }
    default: {
      return false;
    }
  }
}

function elementBackgroundColor(element: FrameStyleElement): string {
  let current: Element | null = element;
  while (current) {
    if (!isFrameStyleElement(current)) {
      current = current.parentElement;
      continue;
    }
    const computedStyle =
      current.ownerDocument.defaultView?.getComputedStyle(current);
    const color = cssColorToHex(
      computedStyle?.getPropertyValue("background-color") ||
        current.style.getPropertyValue("background-color"),
      "",
      current.ownerDocument,
    );
    if (color) {
      return color;
    }
    current = current.parentElement;
  }
  return "#FFFFFF";
}

function stylePropertyNameForElement(
  element: FrameStyleElement,
  property: HtmlDomInlineStyleProperty,
): string {
  if (property === "color" && isFrameSvgElement(element)) {
    return "fill";
  }
  if (property === "backgroundColor") {
    return "background-color";
  }
  if (property === "objectFit") {
    return "object-fit";
  }
  return "color";
}

function cssColorToHex(
  value: string | undefined,
  fallback: string,
  doc: Document | undefined,
): string {
  const color = value?.trim();
  if (!color) {
    return fallback;
  }
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    return color.toUpperCase();
  }
  if (/^#[0-9a-f]{3}$/i.test(color)) {
    return `#${color
      .slice(1)
      .split("")
      .map((char) => {
        return `${char}${char}`;
      })
      .join("")
      .toUpperCase()}`;
  }

  const rgb = rgbColorToHex(color);
  if (rgb) {
    return rgb;
  }

  return browserParsedCssColorToHex(color, doc) ?? fallback;
}

function rgbColorToHex(color: string): string | null {
  const rgbMatch = /^rgba?\(([^)]+)\)$/i.exec(color);
  if (!rgbMatch) {
    return null;
  }

  const [channelsSource, alphaSource] = rgbMatch[1].split("/");
  const parts = channelsSource
    ?.trim()
    .split(/[,\s]+/)
    .filter(Boolean);
  const [red, green, blue, commaAlpha] = parts ?? [];
  const alpha = alphaSource?.trim() ?? commaAlpha;
  if (alpha !== undefined && Number(alpha) === 0) {
    return null;
  }
  if (red === undefined || green === undefined || blue === undefined) {
    return null;
  }
  const channels = [red, green, blue].map((channel) => {
    return Number(channel);
  });
  if (
    channels.some((channel) => {
      return !Number.isFinite(channel);
    })
  ) {
    return null;
  }

  return rgbChannelsToHex(channels[0], channels[1], channels[2]);
}

function browserParsedCssColorToHex(
  color: string,
  doc: Document | undefined,
): string | null {
  const parent = doc?.body ?? doc?.documentElement;
  const view = doc?.defaultView;
  if (!parent || !view) {
    return null;
  }

  const probe = doc.createElement("span");
  probe.style.color = color;
  if (!probe.style.color) {
    return null;
  }
  probe.style.display = "none";
  parent.append(probe);
  const parsed = rgbColorToHex(view.getComputedStyle(probe).color);
  probe.remove();
  return parsed;
}

function rgbChannelsToHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map((channel) => {
      return Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, "0");
    })
    .join("")
    .toUpperCase()}`;
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
    if (isFrameHtmlElement(candidate) && layer === null) {
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
  label.style.justifyContent = "center";
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
  label.style.textAlign = "center";
  label.style.boxShadow = "0 6px 16px rgba(15, 23, 42, 0.18)";
  label.style.pointerEvents = "auto";
}

function styleCommentMarkerLabelText(labelText: HTMLElement): void {
  labelText.dataset.testid = "html-dom-comment-tag-text";
  labelText.style.display = "-webkit-box";
  labelText.style.width = "100%";
  labelText.style.boxSizing = "border-box";
  labelText.style.lineHeight = `${FRAME_COMMENT_LABEL_LINE_HEIGHT}px`;
  labelText.style.whiteSpace = "normal";
  labelText.style.overflow = "hidden";
  labelText.style.overflowWrap = "anywhere";
  labelText.style.padding = "0 18px";
  labelText.style.textAlign = "center";
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
  params.button.style.right = "8px";
  params.button.style.top = "50%";
  params.button.style.display = "inline-flex";
  params.button.style.alignItems = "center";
  params.button.style.justifyContent = "center";
  params.button.style.width = "20px";
  params.button.style.height = "20px";
  params.button.style.border = "0";
  params.button.style.borderRadius = "999px";
  params.button.style.background = "rgba(255, 255, 255, 0.18)";
  params.button.style.color = "white";
  params.button.style.cursor = "pointer";
  params.button.style.fontFamily =
    "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  params.button.style.fontSize = "13px";
  params.button.style.fontWeight = "700";
  params.button.style.lineHeight = "1";
  params.button.style.opacity = "0";
  params.button.style.padding = "0";
  params.button.style.pointerEvents = "none";
  params.button.style.transform = "translateY(-50%)";
  params.button.style.transition = "opacity 120ms ease, background 120ms ease";
}

function positionCommentMarkerParts(params: {
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
  label.append(labelText, deleteButton);
  positionCommentMarkerParts({
    dot,
    label,
    leader,
    placement: params.position.placement,
    rect: params.position.rect,
  });
  marker.append(dot, leader, label);
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

const restoreOriginalStylesForNodes$ = command(
  ({ get, set }, nodeIds: readonly string[]) => {
    if (nodeIds.length === 0) {
      return;
    }

    const doc = currentFrameDocument(get(internalIframeElement$));
    const originalStylesByNodeId = get(internalOriginalStylesByNodeId$);
    const nextStyleEditsByNodeId = { ...get(internalStyleEditsByNodeId$) };
    const nextOriginalStylesByNodeId = { ...originalStylesByNodeId };

    for (const nodeId of nodeIds) {
      const originalStyles = originalStylesByNodeId[nodeId];
      if (!originalStyles) {
        continue;
      }

      const element = doc?.querySelector(nodeSelector(nodeId));
      if (isFrameStyleElement(element)) {
        for (const property of Object.keys(
          originalStyles,
        ) as HtmlDomInlineStyleProperty[]) {
          const styleProperty = stylePropertyNameForElement(element, property);
          const originalValue = originalStyles[property];
          if (originalValue) {
            element.style.setProperty(styleProperty, originalValue);
          } else {
            element.style.removeProperty(styleProperty);
          }
        }
      }

      delete nextStyleEditsByNodeId[nodeId];
      delete nextOriginalStylesByNodeId[nodeId];
    }

    set(internalStyleEditsByNodeId$, nextStyleEditsByNodeId);
    set(internalOriginalStylesByNodeId$, nextOriginalStylesByNodeId);
    set(internalPreparedPayload$, null);
  },
);

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

    set(restoreOriginalStylesForNodes$, deletedComment.targetNodeIds);
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
  set(resetHtmlDomImageEditSignal$);
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
  set(internalActiveColorPanelProperty$, null);
  set(internalColorPopoverOffset$, { left: 0, top: 0 });
  set(internalStyleEditsByNodeId$, {});
  set(internalOriginalStylesByNodeId$, {});
  set(internalImageEditsByNodeId$, {});
  set(internalImageBusy$, false);
  set(internalImageLinkOpen$, false);
  set(internalImageLinkValue$, "");
  set(internalImagePendingAction$, null);
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

interface CommentPopoverTarget {
  readonly element: Element;
  readonly existingComment: HtmlDomEditComment | null;
  readonly nodeId: string;
  readonly selectedNodeIds: readonly string[];
}

function commentPopoverTargetForNode(params: {
  readonly doc: Document;
  readonly getComments: () => readonly HtmlDomEditComment[];
  readonly nodeId: string;
  readonly preferImage: boolean;
}): CommentPopoverTarget | null {
  const element = params.doc.querySelector(nodeSelector(params.nodeId));
  if (!element) {
    return null;
  }

  const existingCommentForNode = commentForNodeId(
    params.getComments(),
    params.nodeId,
  );
  const selectedImage = params.preferImage
    ? imageElementForCommentCandidate(element)
    : null;
  const selectedImageNodeId = selectedImage?.getAttribute(
    HTML_DOM_NODE_ID_ATTR,
  );
  if (!existingCommentForNode && selectedImage && selectedImageNodeId) {
    return {
      element: selectedImage,
      existingComment: commentForNodeId(
        params.getComments(),
        selectedImageNodeId,
      ),
      nodeId: selectedImageNodeId,
      selectedNodeIds: [selectedImageNodeId],
    };
  }

  return {
    element,
    existingComment: existingCommentForNode,
    nodeId: params.nodeId,
    selectedNodeIds:
      selectedImageNodeId && selectedImageNodeId !== params.nodeId
        ? [params.nodeId, selectedImageNodeId]
        : [params.nodeId],
  };
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

function openFrameCommentPopoverForNode(
  params: FrameCommentBindingParams,
  args: {
    nodeId: string;
    mode: "edit" | "view";
    preferImage?: boolean;
  },
): void {
  const target = commentPopoverTargetForNode({
    doc: params.doc,
    getComments: params.getComments,
    nodeId: args.nodeId,
    preferImage: args.preferImage ?? false,
  });
  if (!target) {
    return;
  }
  const {
    element,
    existingComment,
    nodeId: selectedNodeId,
    selectedNodeIds,
  } = target;
  if (args.mode === "edit" && existingComment) {
    params.setEditingCommentId(existingComment.id);
    params.setCommentText(existingComment.comment);
  } else {
    params.setEditingCommentId(null);
    if (!existingComment) {
      params.setCommentText("");
    }
  }
  params.setHoveredNodeId(selectedNodeId);
  params.setSelectedNodeIds(selectedNodeIds);
  params.setCommentPopoverAnchor(
    commentPopoverAnchorForElement({
      element,
      iframe: params.iframe,
      stage: params.stage,
    }),
  );
}

function bindFrameCommentEvents(params: FrameCommentBindingParams): () => void {
  installFrameStyles(params.doc);

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

    const nodeId = (
      isMousePointEvent(event)
        ? (smallestCommentNodeAtPoint(event) ??
          closestCommentNode(event.target))
        : closestCommentNode(event.target)
    )?.getAttribute(HTML_DOM_NODE_ID_ATTR);
    params.setHoveredNodeId(nodeId ?? null);
    if (nodeId && commentForNodeId(params.getComments(), nodeId)) {
      openFrameCommentPopoverForNode(params, { nodeId, mode: "view" });
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
      openFrameCommentPopoverForNode(params, {
        nodeId: markerNodeId,
        mode: "edit",
      });
      return;
    }

    const element = isMousePointEvent(event)
      ? (smallestCommentNodeAtPoint(event) ?? closestCommentNode(event.target))
      : closestCommentNode(event.target);
    const nodeId = element?.getAttribute(HTML_DOM_NODE_ID_ATTR);
    if (!element || !nodeId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    openFrameCommentPopoverForNode(params, {
      nodeId,
      mode: "edit",
      preferImage: true,
    });
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

function syncFrameBindingPresentation(params: {
  readonly commentPopoverAnchor: CommentPopoverAnchor | null;
  readonly comments: readonly HtmlDomEditComment[];
  readonly doc: Document;
  readonly editingCommentId: string | null;
  readonly hoveredNodeId: string | null;
  readonly iframe: HTMLIFrameElement;
  readonly onTargetUnavailable: () => void;
  readonly selectedNodeIds: readonly string[];
  readonly setCommentPopoverAnchor: (
    value: CommentPopoverAnchor | null,
  ) => void;
  readonly stage: HTMLElement;
}): void {
  const selectedElement = params.selectedNodeIds[0]
    ? params.doc.querySelector(nodeSelector(params.selectedNodeIds[0]))
    : null;
  if (params.commentPopoverAnchor && params.selectedNodeIds.length > 0) {
    if (!selectedElement || !isElementInsideFrameViewport(selectedElement)) {
      params.onTargetUnavailable();
      return;
    }

    params.setCommentPopoverAnchor(
      commentPopoverAnchorForElement({
        element: selectedElement,
        iframe: params.iframe,
        stage: params.stage,
      }),
    );
  }

  syncFrameEditState(params.doc, {
    hoveredNodeId: params.hoveredNodeId,
    selectedNodeIds: params.selectedNodeIds,
  });
  syncFrameCommentMarkers(
    params.doc,
    params.comments,
    params.editingCommentId,
    shouldHideCommittedCommentMarkers({
      comments: params.comments,
      editingCommentId: params.editingCommentId,
      selectedNodeIds: params.selectedNodeIds,
    }),
  );
}

function updateFrameEditingComment(params: {
  readonly comments: readonly HtmlDomEditComment[];
  readonly currentEditingCommentId: string | null;
  readonly doc: Document;
  readonly nextEditingCommentId: string | null;
  readonly selectedNodeIds: readonly string[];
  readonly setEditingCommentId: (value: string | null) => void;
}): void {
  if (params.currentEditingCommentId === params.nextEditingCommentId) {
    return;
  }
  params.setEditingCommentId(params.nextEditingCommentId);
  syncFrameCommentMarkers(
    params.doc,
    params.comments,
    params.nextEditingCommentId,
    shouldHideCommittedCommentMarkers({
      comments: params.comments,
      editingCommentId: params.nextEditingCommentId,
      selectedNodeIds: params.selectedNodeIds,
    }),
  );
}

function updateFrameSelectedNodeIds(params: {
  readonly comments: readonly HtmlDomEditComment[];
  readonly doc: Document;
  readonly editingCommentId: string | null;
  readonly hoveredNodeId: string | null;
  readonly nextSelectedNodeIds: readonly string[];
  readonly previousSelectedNodeIds: readonly string[];
  readonly resetFloatingStyleControls: () => void;
  readonly setSelectedNodeIds: (value: readonly string[]) => void;
}): void {
  const wasHidingMarkers = shouldHideCommittedCommentMarkers({
    comments: params.comments,
    editingCommentId: params.editingCommentId,
    selectedNodeIds: params.previousSelectedNodeIds,
  });
  const shouldHideMarkers = shouldHideCommittedCommentMarkers({
    comments: params.comments,
    editingCommentId: params.editingCommentId,
    selectedNodeIds: params.nextSelectedNodeIds,
  });
  if (
    params.previousSelectedNodeIds.join(":") !==
    params.nextSelectedNodeIds.join(":")
  ) {
    params.resetFloatingStyleControls();
  }
  params.setSelectedNodeIds(params.nextSelectedNodeIds);
  syncFrameEditState(params.doc, {
    hoveredNodeId: params.hoveredNodeId,
    selectedNodeIds: params.nextSelectedNodeIds,
  });
  if (wasHidingMarkers !== shouldHideMarkers) {
    syncFrameCommentMarkers(
      params.doc,
      params.comments,
      params.editingCommentId,
      shouldHideMarkers,
    );
  }
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
      syncFrameBindingPresentation({
        commentPopoverAnchor: get(internalCommentPopoverAnchor$),
        comments: get(internalComments$),
        doc,
        editingCommentId: get(internalEditingCommentId$),
        hoveredNodeId: get(internalHoveredNodeId$),
        iframe,
        onTargetUnavailable: () => {
          set(resetHtmlDomCommentDraft$);
        },
        selectedNodeIds: get(internalSelectedNodeIds$),
        setCommentPopoverAnchor: (value) => {
          set(internalCommentPopoverAnchor$, value);
        },
        stage,
      });
    };
    const view = doc.defaultView;
    view?.addEventListener("scroll", syncMarkers, true);
    view?.addEventListener("resize", syncMarkers);
    const currentFrameEditState = () => {
      return {
        hoveredNodeId: get(internalHoveredNodeId$),
        selectedNodeIds: get(internalSelectedNodeIds$),
      };
    };

    const eventCleanup = bindFrameCommentEvents({
      deleteComment: (commentId) => {
        set(deleteHtmlDomComment$, commentId);
      },
      doc,
      getComments: () => {
        return get(internalComments$);
      },
      getDisabled: () => {
        return get(internalSubmitting$) || get(internalImageBusy$);
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
        updateFrameEditingComment({
          comments: get(internalComments$),
          doc,
          currentEditingCommentId: get(internalEditingCommentId$),
          nextEditingCommentId: value,
          selectedNodeIds: get(internalSelectedNodeIds$),
          setEditingCommentId: (nextValue) => {
            set(internalEditingCommentId$, nextValue);
          },
        });
      },
      setHoveredNodeId: (value) => {
        set(internalHoveredNodeId$, value);
        syncFrameEditState(doc, {
          hoveredNodeId: value,
          selectedNodeIds: get(internalSelectedNodeIds$),
        });
        trackFrameEditState({
          doc,
          state: currentFrameEditState,
        });
      },
      setCommentText: (value) => {
        set(internalCommentText$, value);
      },
      setSelectedNodeIds: (value) => {
        updateFrameSelectedNodeIds({
          comments: get(internalComments$),
          doc,
          editingCommentId: get(internalEditingCommentId$),
          hoveredNodeId: get(internalHoveredNodeId$),
          nextSelectedNodeIds: value,
          previousSelectedNodeIds: get(internalSelectedNodeIds$),
          resetFloatingStyleControls: () => {
            set(internalActiveColorPanelProperty$, null);
            set(internalColorPopoverOffset$, { left: 0, top: 0 });
            set(internalImageLinkOpen$, false);
            set(internalImageLinkValue$, "");
            set(internalImagePendingAction$, null);
          },
          setSelectedNodeIds: (nextValue) => {
            set(internalSelectedNodeIds$, nextValue);
          },
        });
        trackFrameEditState({
          doc,
          state: currentFrameEditState,
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

export const toggleHtmlDomColorPanel$ = command(
  ({ get, set }, property: HtmlDomStyleProperty) => {
    const doc = currentFrameDocument(get(internalIframeElement$));
    const selectedNodeIds = get(internalSelectedNodeIds$);
    if (
      !canEditStylePropertyForSelectedNodes({
        doc,
        property,
        selectedNodeIds,
      })
    ) {
      set(internalActiveColorPanelProperty$, null);
      set(internalColorPopoverOffset$, { left: 0, top: 0 });
      return;
    }
    const activeProperty = get(internalActiveColorPanelProperty$);
    set(
      internalActiveColorPanelProperty$,
      activeProperty === property ? null : property,
    );
    set(internalColorPopoverOffset$, { left: 0, top: 0 });
  },
);

export const closeHtmlDomColorPanel$ = command(({ set }) => {
  set(internalActiveColorPanelProperty$, null);
  set(internalColorPopoverOffset$, { left: 0, top: 0 });
});

function imageSourceEditState(params: {
  readonly imageEditsByNodeId: Readonly<Record<string, HtmlDomImageEdits>>;
  readonly nodeId: string;
  readonly url: string;
}): Readonly<Record<string, HtmlDomImageEdits>> {
  return {
    ...params.imageEditsByNodeId,
    [params.nodeId]: {
      ...params.imageEditsByNodeId[params.nodeId],
      src: params.url,
    },
  };
}

function setImageElementSource(element: HTMLImageElement, url: string): void {
  element.setAttribute("src", url);
  element.removeAttribute("srcset");
  element.removeAttribute("sizes");
}

function applyImageSourceEdit(params: {
  readonly element: HTMLImageElement;
  readonly imageEditsByNodeId: Readonly<Record<string, HtmlDomImageEdits>>;
  readonly nodeId: string;
  readonly url: string;
}): Readonly<Record<string, HtmlDomImageEdits>> {
  setImageElementSource(params.element, params.url);
  return imageSourceEditState({
    imageEditsByNodeId: params.imageEditsByNodeId,
    nodeId: params.nodeId,
    url: params.url,
  });
}

export const uploadSelectedHtmlDomImage$ = command(
  async ({ get, set }, file: File, parentSignal: AbortSignal) => {
    const doc = currentFrameDocument(get(internalIframeElement$));
    const selected = selectedImageElementForNodes({
      doc,
      selectedNodeIds: get(internalSelectedNodeIds$),
    });
    if (!selected) {
      toast.error("Select an image first");
      return false;
    }
    if (!inferImageUploadContentType(file)) {
      toast.error("Choose a PNG, JPEG, GIF, WebP, AVIF, or BMP image");
      return false;
    }

    const signal = set(resetHtmlDomImageEditSignal$, parentSignal);
    set(internalImageBusy$, true);
    set(internalPreparedPayload$, null);

    const replaced = await withCleanup(
      tapError(
        (async () => {
          const url = await uploadHtmlDomImage({
            createClient: get(zeroClient$),
            file,
            signal,
          });
          signal.throwIfAborted();
          const nextDoc = currentFrameDocument(get(internalIframeElement$));
          const nextElement = nextDoc?.querySelector(
            nodeSelector(selected.nodeId),
          );
          if (!isFrameImageElement(nextElement)) {
            throw new Error("Selected image is no longer available");
          }

          const nextState = applyImageSourceEdit({
            element: nextElement,
            imageEditsByNodeId: get(internalImageEditsByNodeId$),
            nodeId: selected.nodeId,
            url,
          });
          set(internalImageEditsByNodeId$, nextState);
          set(internalPreparedPayload$, null);
          toast.success("Image replaced");
          return true;
        })(),
        (error) => {
          toast.error(
            htmlDomEditErrorMessage(error, "Failed to replace image"),
          );
        },
      ),
      () => {
        if (!signal.aborted) {
          set(internalImageBusy$, false);
        }
      },
    );

    return replaced ?? false;
  },
);

export const replaceSelectedHtmlDomImageUrl$ = command(
  ({ get, set }, value: string, parentSignal: AbortSignal) => {
    const url = normalizeImageLinkUrl(value);
    if (!url) {
      toast.error("Enter a valid image URL");
      return false;
    }

    const doc = currentFrameDocument(get(internalIframeElement$));
    const selected = selectedImageElementForNodes({
      doc,
      selectedNodeIds: get(internalSelectedNodeIds$),
    });
    if (!selected) {
      toast.error("Select an image first");
      return false;
    }

    const signal = set(resetHtmlDomImageEditSignal$, parentSignal);
    set(internalImageBusy$, true);
    set(internalPreparedPayload$, null);

    const nextDoc = currentFrameDocument(get(internalIframeElement$));
    const nextElement = nextDoc?.querySelector(nodeSelector(selected.nodeId));
    if (!isFrameImageElement(nextElement)) {
      toast.error("Selected image is no longer available");
      if (!signal.aborted) {
        set(internalImageBusy$, false);
      }
      return false;
    }

    const nextState = applyImageSourceEdit({
      element: nextElement,
      imageEditsByNodeId: get(internalImageEditsByNodeId$),
      nodeId: selected.nodeId,
      url,
    });
    set(internalImageEditsByNodeId$, nextState);
    set(internalPreparedPayload$, null);
    toast.success("Image replaced");
    if (!signal.aborted) {
      set(internalImageBusy$, false);
    }
    return true;
  },
);

export const applySelectedHtmlDomImageLayout$ = command(
  ({ get, set }, layout: HtmlDomImageLayout) => {
    const doc = currentFrameDocument(get(internalIframeElement$));
    const selected = selectedImageElementForNodes({
      doc,
      selectedNodeIds: get(internalSelectedNodeIds$),
    });
    if (!selected) {
      return;
    }
    if (imageLayoutForElement(selected.element) === layout) {
      return;
    }

    const styleEditsByNodeId = { ...get(internalStyleEditsByNodeId$) };
    const originalStylesByNodeId = { ...get(internalOriginalStylesByNodeId$) };
    const styleProperty = stylePropertyNameForElement(
      selected.element,
      "objectFit",
    );

    originalStylesByNodeId[selected.nodeId] = {
      ...originalStylesByNodeId[selected.nodeId],
      objectFit:
        originalStylesByNodeId[selected.nodeId]?.objectFit ??
        selected.element.style.getPropertyValue(styleProperty),
    };
    selected.element.style.setProperty(styleProperty, layout);
    styleEditsByNodeId[selected.nodeId] = {
      ...styleEditsByNodeId[selected.nodeId],
      objectFit: layout,
    };

    set(internalOriginalStylesByNodeId$, originalStylesByNodeId);
    set(internalStyleEditsByNodeId$, styleEditsByNodeId);
    set(internalPreparedPayload$, null);
  },
);

export const setHtmlDomColorPopoverOffset$ = command(
  ({ set }, offset: HtmlDomColorPopoverOffset) => {
    set(internalColorPopoverOffset$, offset);
  },
);

export const applyHtmlDomColorStyle$ = command(
  (
    { get, set },
    params: {
      readonly property: HtmlDomStyleProperty;
      readonly value: string;
    },
  ) => {
    const selectedNodeIds = get(internalSelectedNodeIds$);
    if (selectedNodeIds.length === 0) {
      return;
    }

    const iframe = get(internalIframeElement$);
    const doc = currentFrameDocument(iframe);
    if (
      !canEditStylePropertyForSelectedNodes({
        doc,
        property: params.property,
        selectedNodeIds,
      })
    ) {
      set(internalActiveColorPanelProperty$, null);
      return;
    }
    const styleEditsByNodeId = { ...get(internalStyleEditsByNodeId$) };
    const originalStylesByNodeId = { ...get(internalOriginalStylesByNodeId$) };

    for (const nodeId of selectedNodeIds) {
      const element = doc?.querySelector(nodeSelector(nodeId));
      if (!isFrameStyleElement(element)) {
        continue;
      }
      const targets =
        params.property === "color"
          ? editableTextColorTargets(element)
          : [element];
      for (const target of targets) {
        const targetNodeId =
          target.getAttribute(HTML_DOM_NODE_ID_ATTR) ?? nodeId;
        const styleProperty = stylePropertyNameForElement(
          target,
          params.property,
        );

        originalStylesByNodeId[targetNodeId] = {
          ...originalStylesByNodeId[targetNodeId],
          [params.property]:
            originalStylesByNodeId[targetNodeId]?.[params.property] ??
            target.style.getPropertyValue(styleProperty),
        };
        target.style.setProperty(styleProperty, params.value);
        styleEditsByNodeId[targetNodeId] = {
          ...styleEditsByNodeId[targetNodeId],
          [params.property]: params.value,
        };
      }
    }

    set(internalOriginalStylesByNodeId$, originalStylesByNodeId);
    set(internalStyleEditsByNodeId$, styleEditsByNodeId);
    set(internalPreparedPayload$, null);
  },
);

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
  set(internalActiveColorPanelProperty$, null);
  set(internalColorPopoverOffset$, { left: 0, top: 0 });
  set(internalImageLinkOpen$, false);
  set(internalImageLinkValue$, "");
  set(internalImagePendingAction$, null);
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

export const toggleHtmlDomImageLinkOpen$ = command(({ get, set }) => {
  set(internalImageLinkOpen$, !get(internalImageLinkOpen$));
});

export const setHtmlDomImageLinkValue$ = command(({ set }, value: string) => {
  set(internalImageLinkValue$, value);
});

export const setHtmlDomImagePendingAction$ = command(
  ({ set }, value: HtmlDomImagePendingAction | null) => {
    set(internalImagePendingAction$, value);
  },
);

export const discardHtmlDomComments$ = command(({ get, set }) => {
  const readyLoadState = get(internalLoadState$);
  const doc = currentFrameDocument(get(internalIframeElement$));

  set(resetHtmlDomImageEditSignal$);
  set(internalComments$, []);
  set(internalCommentsOpen$, false);
  set(internalActiveColorPanelProperty$, null);
  set(internalColorPopoverOffset$, { left: 0, top: 0 });
  set(internalStyleEditsByNodeId$, {});
  set(internalOriginalStylesByNodeId$, {});
  set(internalImageEditsByNodeId$, {});
  set(internalImageBusy$, false);
  set(internalImageLinkOpen$, false);
  set(internalImageLinkValue$, "");
  set(internalImagePendingAction$, null);
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

export const applyHtmlDomStyleEdits$ = command(
  async (
    { get, set },
    params: ApplyHtmlDomStyleEditsParams,
    _parentSignal: AbortSignal,
  ) => {
    const readyLoadState = get(internalLoadState$);
    const hasPendingDomEdits =
      hasStyleEdits(get(internalStyleEditsByNodeId$)) ||
      hasImageEdits(get(internalImageEditsByNodeId$));
    if (
      readyLoadState.status !== "ready" ||
      get(internalComments$).length > 0 ||
      !hasPendingDomEdits ||
      get(internalSubmitting$)
    ) {
      return;
    }

    const signal = set(resetHtmlDomEditRequestSignal$);
    set(internalSubmitting$, true);
    set(internalPreparedPayload$, null);

    const apply = async () => {
      const html = htmlWithEditOverlaysRemoved({
        fallbackHtml: readyLoadState.html,
        frameDocument: currentFrameDocument(get(internalIframeElement$)),
      });
      params.onStarted?.();
      if (params.onApplied) {
        const applied = await tapError(
          (async () => {
            await params.onApplied?.(html);
            return true;
          })(),
          (error) => {
            toast.error(htmlDomEditErrorMessage(error, "Failed to apply edit"));
          },
        );
        signal.throwIfAborted();
        if (!applied) {
          params.onFailed?.();
        }
        return;
      }
      toast.success("Edit applied");
    };

    await withCleanup(apply(), () => {
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
    const styleEditsByNodeId = get(internalStyleEditsByNodeId$);
    const imageEditsByNodeId = get(internalImageEditsByNodeId$);
    const imageBusy = get(internalImageBusy$);
    const doc = currentFrameDocument(get(internalIframeElement$));
    const editableStyleProperties = editableStylePropertiesForSelectedNodes({
      doc,
      selectedNodeIds,
    });
    const currentComment = commentForSelectedNodes({
      comments,
      selectedNodeIds,
    });

    return {
      activeColorPanelProperty: get(internalActiveColorPanelProperty$),
      canApplyStyleEdits:
        loadState.status === "ready" &&
        comments.length === 0 &&
        (hasStyleEdits(styleEditsByNodeId) ||
          hasImageEdits(imageEditsByNodeId)) &&
        !submitting &&
        !imageBusy,
      canAddComment: editingCommentId
        ? commentText.trim() !== "" && !imageBusy
        : selectedNodeIds.length > 0 &&
          commentText.trim() !== "" &&
          !hasCommentForSelectedNodes({ comments, selectedNodeIds }) &&
          !imageBusy,
      canEditSelectedStyle: editableStyleProperties.length > 0,
      canSend:
        loadState.status === "ready" &&
        comments.length > 0 &&
        !submitting &&
        !imageBusy,
      colorPopoverOffset: get(internalColorPopoverOffset$),
      commentsOpen: get(internalCommentsOpen$),
      commentText,
      commentPopoverAnchor: get(internalCommentPopoverAnchor$),
      comments,
      currentComment,
      editableStyleProperties,
      editingCommentId,
      imageBusy,
      imageLinkOpen: get(internalImageLinkOpen$),
      imageLinkValue: get(internalImageLinkValue$),
      imagePendingAction: get(internalImagePendingAction$),
      loadState,
      popoverTextAreaKey: [
        selectedNodeIds.join(":"),
        editingCommentId ?? "new",
        currentComment?.id ?? "draft",
      ].join("|"),
      prepared: get(internalPreparedPayload$) !== null,
      selectedImage: selectedImageForNodes({ doc, selectedNodeIds }),
      selectedStyle: selectedStyleForNodes({ doc, selectedNodeIds }),
      submitting,
    };
  },
);
