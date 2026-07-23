import type { ReactNode, Ref, SyntheticEvent } from "react";
import {
  IconDownload,
  IconLoader2,
  IconPresentation,
  IconSparkles,
  IconX,
} from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui";
import { zeroHostContract } from "@vm0/api-contracts/contracts/zero-host";
import { toast } from "@vm0/ui/components/ui/sonner";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { ApiError, accept } from "../../lib/accept.ts";
import {
  zeroClient$,
  type ZeroClientFactory,
} from "../../signals/api-client.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { refreshPresentationHtmlPreviews$ } from "../../signals/zero-page/presentation-html-cache-bust.ts";
import { createCurrentPresentationDraft } from "../../signals/zero-page/presentation-html-editor-draft.ts";
import {
  createPresentationSlideListSignals,
  type PresentationSlideListSignals,
} from "../../signals/zero-page/presentation-html-slide-list.ts";
import {
  presentationEditorCloseDialogOpen$,
  setPresentationEditorCloseDialogOpen$,
} from "../../signals/zero-page/zero-artifact-sidebar.ts";
import { detach, Reason, tapError } from "../../signals/utils.ts";
import { downloadPresentationHtmlStringPptx } from "./presentation-html-pptx-download.ts";
import {
  applyPresentationSpeakerNotesPatch,
  parsePresentationEditDraft,
  patchPresentationHtml,
  previewPresentationHtml,
  type PresentationEditBlock,
  type PresentationEditDraft,
  type PresentationMoveBlock,
  type PresentationSlideDraft,
} from "./presentation-html-edit-protocol.ts";
import {
  createGeneratedPresentationElementId,
  normalizePresentationElementOffset,
  PRESENTATION_ELEMENT_OFFSET_RUNTIME_APPLIED_ATTRIBUTE,
} from "./presentation-html-element-offsets.ts";
import {
  attachmentFilenameFromUrl,
  publicAttachmentUrl,
  readableAttachmentResourceUrl,
} from "./zero-attachment-url.ts";
import { fallbackHtmlPreviewTitle } from "./zero-attachment-preview.tsx";

interface PresentationHtmlEditorProps {
  readonly onClose: (publishedUrl?: string) => void;
  readonly url: string;
}

type EditorDraft = PresentationEditDraft & {
  readonly editorSession: PresentationEditorSession;
  readonly publicUrl: string;
};

interface MutableValue<T> {
  current: T;
}

interface PresentationEditorSession {
  readonly activeSlideIdRef: MutableValue<string>;
  readonly blocksRef: MutableValue<readonly PresentationEditBlock[]>;
  readonly busyRef: MutableValue<SVGSVGElement | null>;
  readonly pendingThumbnailSlideIdRef: MutableValue<string | null>;
  readonly previewFrameRef: MutableValue<HTMLIFrameElement | null>;
  readonly publishedSignatureRef: MutableValue<string>;
  readonly publishedUrlRef: MutableValue<string | null>;
  readonly publishingRef: MutableValue<boolean>;
  readonly moveBlocksRef: MutableValue<readonly PresentationMoveBlock[]>;
  readonly slideList: PresentationSlideListSignals;
  readonly slidesRef: MutableValue<readonly PresentationSlideDraft[]>;
  readonly statusRef: MutableValue<HTMLDivElement | null>;
  readonly thumbnailUpdateFrameRef: MutableValue<number | null>;
}

function mutableValue<T>(current: T): MutableValue<T> {
  return { current };
}

function createPresentationEditorSession(
  draft: PresentationEditDraft,
  publicUrl: string,
): PresentationEditorSession {
  const blocksRef = mutableValue<readonly PresentationEditBlock[]>(
    draft.blocks,
  );
  const moveBlocksRef = mutableValue<readonly PresentationMoveBlock[]>(
    draft.moveBlocks,
  );
  const slidesRef = mutableValue<readonly PresentationSlideDraft[]>(
    draft.slides,
  );
  const slideList = createPresentationSlideListSignals({
    loadThumbnail: (frame, slideId) => {
      setSandboxedFrameHtml(
        frame,
        previewPresentationHtml({
          activeSlideId: slideId,
          html: buildPresentationEditorHtml({
            blocks: blocksRef.current,
            html: draft.html,
            moveBlocks: moveBlocksRef.current,
            slides: slidesRef.current,
          }),
          sourceUrl: publicUrl,
        }),
      );
    },
    releaseThumbnail: releaseSandboxedFrameHtml,
  });
  return {
    activeSlideIdRef: mutableValue(draft.slides[0]?.id ?? ""),
    blocksRef,
    busyRef: mutableValue<SVGSVGElement | null>(null),
    pendingThumbnailSlideIdRef: mutableValue<string | null>(null),
    previewFrameRef: mutableValue<HTMLIFrameElement | null>(null),
    publishedSignatureRef: mutableValue(
      editSignature({
        blocks: draft.blocks,
        moveBlocks: draft.moveBlocks,
        slides: draft.slides,
      }),
    ),
    publishedUrlRef: mutableValue<string | null>(null),
    publishingRef: mutableValue(false),
    moveBlocksRef,
    slideList,
    slidesRef,
    statusRef: mutableValue<HTMLDivElement | null>(null),
    thumbnailUpdateFrameRef: mutableValue<number | null>(null),
  };
}

const currentPresentationDraft$ = createCurrentPresentationDraft<EditorDraft>(
  async (url, signal) => {
    const publicUrl = publicAttachmentUrl(url);
    const response = await fetch(readableAttachmentResourceUrl(publicUrl), {
      cache: "reload",
      mode: "cors",
      signal,
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch presentation HTML (${response.status})`);
    }
    const draft = parsePresentationEditDraft(await response.text());
    return {
      ...draft,
      editorSession: createPresentationEditorSession(draft, publicUrl),
      publicUrl,
    };
  },
);
const THUMBNAIL_CANVAS_WIDTH = 1920;
const THUMBNAIL_CANVAS_HEIGHT = 1080;
const THUMBNAIL_SCALE = 0.1125;
const PREVIEW_CANVAS_WIDTH = 1920;
const PREVIEW_CANVAS_HEIGHT = 1080;
const PREVIEW_FIT_SCALE = 0.99;

function setSandboxedFrameHtml(frame: HTMLIFrameElement, html: string): void {
  releaseSandboxedFrameHtml(frame);
  const url = URL.createObjectURL(
    new Blob([html], { type: "text/html;charset=utf-8" }),
  );
  frame.dataset.vm0EditorObjectUrl = url;
  frame.src = url;
}

function releaseSandboxedFrameHtml(frame: HTMLIFrameElement): void {
  const url = frame.dataset.vm0EditorObjectUrl;
  if (!url) {
    return;
  }
  URL.revokeObjectURL(url);
  delete frame.dataset.vm0EditorObjectUrl;
}

function revealPresentationPreviewSlide(
  event: SyntheticEvent<HTMLIFrameElement>,
): void {
  const frame = event.currentTarget;
  const doc = frame.contentDocument;
  const slide = doc?.querySelector<HTMLElement>("[data-vm0-editor-stage] > *");
  const view = doc?.defaultView;
  if (!slide || !view || view.getComputedStyle(slide).display !== "none") {
    return;
  }
  slide.style.setProperty("display", "block", "important");
}

async function redeployPresentationHtml(params: {
  readonly createClient: ZeroClientFactory;
  readonly html: string;
  readonly publicUrl: string;
  readonly signal: AbortSignal;
}): Promise<string> {
  params.signal.throwIfAborted();
  const client = params.createClient(zeroHostContract, { apiBase: "api" });
  const completed = await accept(
    client.redeployPresentationHtml({
      body: {
        url: params.publicUrl,
        html: params.html,
      },
      fetchOptions: { signal: params.signal },
    }),
    [200],
  );
  return completed.body.artifactUrl ?? completed.body.url;
}

async function generatePresentationSpeakerNotes(params: {
  readonly createClient: ZeroClientFactory;
  readonly html: string;
  readonly signal: AbortSignal;
}) {
  params.signal.throwIfAborted();
  const client = params.createClient(zeroHostContract, { apiBase: "api" });
  const completed = await accept(
    client.generatePresentationSpeakerNotes({
      body: {
        html: params.html,
        mode: "fill-empty",
      },
      fetchOptions: { signal: params.signal },
    }),
    [200],
  );
  return completed.body;
}

function updateBlockText(
  blocks: readonly PresentationEditBlock[],
  target: PresentationEditBlock,
  text: string,
): readonly PresentationEditBlock[] {
  return blocks.map((block) => {
    if (block.slideId === target.slideId && block.editId === target.editId) {
      return { ...block, text };
    }
    return block;
  });
}

function updateSlideNotes(
  slides: readonly PresentationSlideDraft[],
  slideId: string,
  notes: string,
): readonly PresentationSlideDraft[] {
  return slides.map((slide) => {
    if (slide.id === slideId) {
      return { ...slide, notes };
    }
    return slide;
  });
}

function updateMoveBlock(
  blocks: readonly PresentationMoveBlock[],
  moveId: string,
  offsetX: number,
  offsetY: number,
): readonly PresentationMoveBlock[] {
  const hasMovement = offsetX !== 0 || offsetY !== 0;
  return blocks.map((block) => {
    if (block.moveId !== moveId) {
      return block;
    }
    const generatedElementId = hasMovement && block.elementId === null;
    return {
      ...block,
      elementId: hasMovement
        ? (block.elementId ?? createGeneratedPresentationElementId())
        : block.elementIdGenerated
          ? null
          : block.elementId,
      elementIdGenerated: block.elementIdGenerated || generatedElementId,
      offsetX,
      offsetY,
    };
  });
}

function editSignature(params: {
  readonly blocks: readonly PresentationEditBlock[];
  readonly moveBlocks: readonly PresentationMoveBlock[];
  readonly slides: readonly PresentationSlideDraft[];
}): string {
  return JSON.stringify({
    blocks: params.blocks.map((block) => {
      return {
        editId: block.editId,
        slideId: block.slideId,
        text: block.text,
      };
    }),
    moveBlocks: params.moveBlocks.map((block) => {
      return {
        elementId: block.elementId,
        moveId: block.moveId,
        offsetX: block.offsetX,
        offsetY: block.offsetY,
        slideId: block.slideId,
      };
    }),
    slides: params.slides.map((slide) => {
      return {
        id: slide.id,
        notes: slide.notes,
      };
    }),
  });
}

function PresentationEditorHeader({
  busyRef,
  onClose,
  onDownloadPptx,
  onGenerateSpeakerNotes,
  statusRef,
  title,
}: {
  busyRef?: Ref<SVGSVGElement>;
  onClose: () => void;
  onDownloadPptx: (() => void) | undefined;
  onGenerateSpeakerNotes: (() => void) | undefined;
  statusRef?: Ref<HTMLDivElement>;
  title: string;
}) {
  return (
    <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 py-2 sm:gap-3 sm:px-4">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <IconPresentation size={17} stroke={1.5} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {title}
        </div>
        <div
          ref={statusRef}
          className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground"
        >
          <IconLoader2
            ref={busyRef}
            size={12}
            className="hidden shrink-0 animate-spin"
          />
          <span>Presentation editor</span>
        </div>
      </div>
      {onDownloadPptx && (
        <button
          type="button"
          data-presentation-editor-action="true"
          aria-label="Download edited PPTX"
          title="Download edited PPTX"
          onClick={onDownloadPptx}
          className="inline-flex h-8 w-8 items-center justify-center gap-2 rounded-md text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground sm:w-auto sm:px-2"
        >
          <IconDownload size={16} stroke={1.5} />
          <span className="hidden sm:inline">PPTX</span>
        </button>
      )}
      <button
        type="button"
        data-presentation-editor-action="true"
        data-presentation-speaker-notes-action="true"
        aria-label="Generate speaker notes"
        title="Generate speaker notes"
        disabled={!onGenerateSpeakerNotes}
        onClick={onGenerateSpeakerNotes}
        className="inline-flex h-8 w-8 items-center justify-center gap-2 rounded-md text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-50 data-[generating=true]:bg-violet-500/10 data-[generating=true]:text-violet-600 data-[generating=true]:disabled:opacity-100 dark:data-[generating=true]:text-violet-400 sm:w-auto sm:px-2"
      >
        <IconSparkles size={16} stroke={1.5} />
        <span data-speaker-notes-idle className="hidden sm:inline">
          Speaker notes
        </span>
        <span data-speaker-notes-generating className="hidden">
          Generating
          <span aria-hidden="true" className="inline-flex">
            <span className="speaker-notes-dot-1">.</span>
            <span className="speaker-notes-dot-2">.</span>
            <span className="speaker-notes-dot-3">.</span>
          </span>
        </span>
      </button>
      <button
        type="button"
        data-presentation-editor-action="true"
        aria-label="Close presentation editor"
        onClick={onClose}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
      >
        <IconX size={16} stroke={1.5} />
      </button>
    </header>
  );
}

function PresentationEditorShell({
  children,
  onClose,
  title,
}: {
  children: ReactNode;
  onClose: () => void;
  title: string;
}) {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <PresentationEditorHeader
        onClose={onClose}
        onDownloadPptx={undefined}
        onGenerateSpeakerNotes={undefined}
        title={title}
      />
      {children}
    </div>
  );
}

function PresentationEditorLoading({
  onClose,
  title,
}: {
  onClose: () => void;
  title: string;
}) {
  return (
    <PresentationEditorShell title={title} onClose={onClose}>
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <IconLoader2 size={20} className="animate-spin" />
      </div>
    </PresentationEditorShell>
  );
}

function PresentationEditorError({
  message,
  onClose,
  title,
}: {
  message: string;
  onClose: () => void;
  title: string;
}) {
  return (
    <PresentationEditorShell title={title} onClose={onClose}>
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {message}
      </div>
    </PresentationEditorShell>
  );
}

function SlideList({
  activeSlideId,
  setActiveSlideId,
  signals,
  slides,
}: {
  activeSlideId: string;
  setActiveSlideId: (id: string) => void;
  signals: PresentationSlideListSignals;
  slides: readonly PresentationSlideDraft[];
}) {
  const setRootRef = useSet(signals.setRootRef$);
  return (
    <aside
      ref={setRootRef}
      data-testid="presentation-editor-slide-list"
      className="min-h-0 overflow-x-auto overflow-y-hidden border-b border-border/60 bg-[#eeeeee] px-3 py-3 md:overflow-auto md:border-b-0 md:border-r md:px-5 md:py-6"
    >
      <div className="flex gap-3 md:block md:space-y-6">
        {slides.map((slide, index) => {
          const active = slide.id === activeSlideId;
          return (
            <div
              key={slide.id}
              className="flex w-[216px] shrink-0 flex-col items-center gap-2 md:w-auto"
            >
              <button
                type="button"
                data-slide-id={slide.id}
                data-active={active ? "true" : "false"}
                onClick={() => {
                  setActiveSlideId(slide.id);
                }}
                aria-label={`Open slide ${String(index + 1)}`}
                className={cn(
                  "aspect-video w-full overflow-hidden rounded-lg border-2 bg-white shadow-sm transition-colors data-[active=false]:border-transparent data-[active=true]:border-[#0f82ff]",
                )}
              >
                <iframe
                  title={`Slide ${String(index + 1)} thumbnail`}
                  data-slide-thumbnail-frame={slide.id}
                  data-slide-thumbnail-active={active ? "true" : "false"}
                  sandbox="allow-same-origin allow-scripts"
                  onLoad={revealPresentationPreviewSlide}
                  className="pointer-events-none origin-top-left border-0 bg-white"
                  style={{
                    width: THUMBNAIL_CANVAS_WIDTH,
                    height: THUMBNAIL_CANVAS_HEIGHT,
                    transform: `scale(${THUMBNAIL_SCALE})`,
                  }}
                />
              </button>
              <span
                data-slide-index-label={slide.id}
                className={cn(
                  "flex h-7 min-w-6 items-center justify-center rounded px-2 text-lg font-semibold",
                  active ? "bg-[#0f82ff] text-white" : "text-[#858585]",
                )}
              >
                {index + 1}
              </span>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

const EDITOR_MOVE_SELECTOR = "[data-vm0-editor-move-id]";
const EDITOR_SELECTION_OVERLAY_ATTRIBUTE = "data-vm0-editor-selection-overlay";
const EDITOR_TEXT_SELECTOR = "[data-vm0-editor-edit-id]";
const EDITOR_SLIDE_SELECTOR = [
  "[data-vm0-slide]",
  "[data-slide]",
  "[data-slide-index]",
  "[data-page]",
  ".ppt-slide",
  ".presentation-slide",
  ".deck-slide",
  ".slide-page",
  ".slide",
  "section",
].join(",");
const DRAG_START_THRESHOLD = 4;
const SELECTION_OVERLAY_GAP = 4;

interface PresentationPointerDrag {
  readonly baseBottom: number;
  readonly baseLeft: number;
  readonly baseRight: number;
  readonly baseTop: number;
  readonly candidate: HTMLElement;
  currentOffsetX: number;
  currentOffsetY: number;
  dragging: boolean;
  readonly initialOffsetX: number;
  readonly initialOffsetY: number;
  readonly initialPixelX: number;
  readonly initialPixelY: number;
  readonly initialTranslate: string;
  readonly layoutHeight: number;
  readonly layoutWidth: number;
  readonly moveId: string;
  readonly pointerId: number;
  readonly slideRect: DOMRect;
  readonly startX: number;
  readonly startY: number;
}

interface PresentationPixelTranslate {
  readonly x: number;
  readonly y: number;
}

function frameEventElement(target: EventTarget | null): Element | null {
  if (!target) {
    return null;
  }
  const candidate = target as {
    readonly closest?: unknown;
    readonly nodeType?: unknown;
  };
  return candidate.nodeType === 1 && typeof candidate.closest === "function"
    ? (target as Element)
    : null;
}

function closestFrameElement(
  target: EventTarget | null,
  selector: string,
): HTMLElement | null {
  const element = frameEventElement(target);
  const closest = element?.closest(selector);
  return closest?.namespaceURI === "http://www.w3.org/1999/xhtml"
    ? (closest as HTMLElement)
    : null;
}

function clampDragAxis(
  value: number,
  minimum: number,
  maximum: number,
): number {
  return minimum <= maximum ? Math.min(maximum, Math.max(minimum, value)) : 0;
}

function setCandidateTranslate(
  drag: PresentationPointerDrag,
  offsetX: number,
  offsetY: number,
): void {
  drag.candidate.style.setProperty(
    "translate",
    `${String(offsetX * drag.layoutWidth)}px ${String(
      offsetY * drag.layoutHeight,
    )}px`,
  );
}

function cssPixelValue(value: string | undefined): number {
  if (!value?.endsWith("px")) {
    return 0;
  }
  const pixelValue = Number(value.slice(0, -2));
  return Number.isFinite(pixelValue) ? pixelValue : 0;
}

function appliedCandidatePixelTranslate(
  candidate: HTMLElement,
): PresentationPixelTranslate {
  const [x, y] = candidate.style
    .getPropertyValue("translate")
    .trim()
    .split(/\s+/, 2);
  return { x: cssPixelValue(x), y: cssPixelValue(y) };
}

function removeUnsupportedMoveCandidates(doc: Document): void {
  const view = doc.defaultView;
  if (!view) {
    return;
  }
  for (const candidate of Array.from(
    doc.querySelectorAll<HTMLElement>(EDITOR_MOVE_SELECTOR),
  )) {
    const layout = candidate.parentElement;
    const candidateRect = candidate.getBoundingClientRect();
    const layoutRect = layout?.getBoundingClientRect();
    const candidateStyle = view.getComputedStyle(candidate);
    const layoutStyle = layout ? view.getComputedStyle(layout) : null;
    const authoredTranslate = candidateStyle.getPropertyValue("translate");
    const runtimeApplied = candidate.hasAttribute(
      PRESENTATION_ELEMENT_OFFSET_RUNTIME_APPLIED_ATTRIBUTE,
    );
    if (
      !layout ||
      !layoutRect ||
      candidateRect.width <= 0 ||
      candidateRect.height <= 0 ||
      layoutRect.width <= 0 ||
      layoutRect.height <= 0 ||
      layoutStyle?.display === "contents" ||
      (!runtimeApplied &&
        authoredTranslate !== "" &&
        authoredTranslate !== "none" &&
        authoredTranslate !== "0px" &&
        authoredTranslate !== "0px 0px")
    ) {
      delete candidate.dataset.vm0EditorMoveId;
    }
  }
}

function wireLegacyTextEditing(params: {
  readonly doc: Document;
  readonly syncText: (element: HTMLElement) => void;
}): () => void {
  const cleanupListeners: (() => void)[] = [];
  for (const element of Array.from(
    params.doc.querySelectorAll<HTMLElement>(EDITOR_TEXT_SELECTOR),
  )) {
    element.setAttribute("contenteditable", "true");
    element.setAttribute("role", "textbox");
    element.spellcheck = false;
    const computedPosition =
      params.doc.defaultView?.getComputedStyle(element).position;
    if (!computedPosition || computedPosition === "static") {
      element.style.setProperty("position", "relative", "important");
    }
    element.style.setProperty("z-index", "2", "important");
    element.style.setProperty("pointer-events", "auto", "important");
    element.style.setProperty("user-select", "text", "important");
    element.style.setProperty("-webkit-user-select", "text", "important");
    element.style.setProperty(
      "-webkit-user-modify",
      "read-write-plaintext-only",
      "important",
    );
    const focusElement = () => {
      element.focus();
    };
    const syncElement = () => {
      params.syncText(element);
    };
    element.addEventListener("pointerdown", focusElement);
    element.addEventListener("input", syncElement);
    element.addEventListener("blur", syncElement);
    cleanupListeners.push(() => {
      element.removeEventListener("pointerdown", focusElement);
      element.removeEventListener("input", syncElement);
      element.removeEventListener("blur", syncElement);
    });
  }
  return () => {
    for (const cleanup of cleanupListeners) {
      cleanup();
    }
  };
}

interface WireMovableFrameParams {
  readonly doc: Document;
  readonly moveBlocks: readonly PresentationMoveBlock[];
  readonly syncText: (element: HTMLElement) => void;
  readonly updateMovement: (
    moveId: string,
    offsetX: number,
    offsetY: number,
  ) => void;
}

interface MovableFrameState {
  readonly offsets: Map<string, { offsetX: number; offsetY: number }>;
  pointerDrag: PresentationPointerDrag | null;
  selected: HTMLElement | null;
  selectionOverlayFrame: number | null;
  selectionMutationObserver: MutationObserver | null;
  selectionResizeObserver: ResizeObserver | null;
  readonly selectionOverlay: HTMLElement;
  textEditing: HTMLElement | null;
}

function createMovableFrameState(
  doc: Document,
  moveBlocks: readonly PresentationMoveBlock[],
): MovableFrameState {
  for (const existing of Array.from(
    doc.querySelectorAll(`[${EDITOR_SELECTION_OVERLAY_ATTRIBUTE}]`),
  )) {
    existing.remove();
  }
  const selectionOverlay = doc.createElement("div");
  selectionOverlay.setAttribute(EDITOR_SELECTION_OVERLAY_ATTRIBUTE, "");
  selectionOverlay.dataset.vm0EditorOwned = "true";
  selectionOverlay.setAttribute("aria-hidden", "true");
  selectionOverlay.hidden = true;
  doc.body.append(selectionOverlay);
  return {
    offsets: new Map(
      moveBlocks.map((block) => {
        return [
          block.moveId,
          { offsetX: block.offsetX, offsetY: block.offsetY },
        ] as const;
      }),
    ),
    pointerDrag: null,
    selected: null,
    selectionOverlayFrame: null,
    selectionMutationObserver: null,
    selectionResizeObserver: null,
    selectionOverlay,
    textEditing: null,
  };
}

function setSelectionOverlayPixelStyle(
  overlay: HTMLElement,
  property: "height" | "left" | "top" | "width",
  value: number,
): void {
  overlay.style.setProperty(property, `${String(value)}px`, "important");
}

function updateMoveSelectionOverlay(state: MovableFrameState): void {
  const candidate = state.selected;
  if (!candidate?.isConnected) {
    state.selectionOverlay.hidden = true;
    return;
  }
  const rect = candidate.getBoundingClientRect();
  if (
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    state.selectionOverlay.hidden = true;
    return;
  }
  setSelectionOverlayPixelStyle(
    state.selectionOverlay,
    "left",
    rect.left - SELECTION_OVERLAY_GAP,
  );
  setSelectionOverlayPixelStyle(
    state.selectionOverlay,
    "top",
    rect.top - SELECTION_OVERLAY_GAP,
  );
  setSelectionOverlayPixelStyle(
    state.selectionOverlay,
    "width",
    rect.width + SELECTION_OVERLAY_GAP * 2,
  );
  setSelectionOverlayPixelStyle(
    state.selectionOverlay,
    "height",
    rect.height + SELECTION_OVERLAY_GAP * 2,
  );
  state.selectionOverlay.hidden = false;
}

function queueMoveSelectionOverlayUpdate(state: MovableFrameState): void {
  if (state.selectionOverlayFrame !== null) {
    return;
  }
  const view = state.selectionOverlay.ownerDocument.defaultView;
  if (!view) {
    updateMoveSelectionOverlay(state);
    return;
  }
  state.selectionOverlayFrame = view.requestAnimationFrame(() => {
    state.selectionOverlayFrame = null;
    updateMoveSelectionOverlay(state);
  });
}

function observeMoveSelection(state: MovableFrameState): void {
  const resizeObserver = state.selectionResizeObserver;
  resizeObserver?.disconnect();
  const mutationObserver = state.selectionMutationObserver;
  mutationObserver?.disconnect();
  const candidate = state.selected;
  if (!candidate) {
    return;
  }
  resizeObserver?.observe(candidate);
  const layout = candidate.parentElement;
  if (layout) {
    resizeObserver?.observe(layout);
  }
  const slide = candidate.closest<HTMLElement>(EDITOR_SLIDE_SELECTOR);
  if (slide && slide !== layout) {
    resizeObserver?.observe(slide);
  }
  mutationObserver?.observe(slide ?? layout ?? candidate, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
}

function clearMoveSelection(state: MovableFrameState): void {
  if (state.selected) {
    delete state.selected.dataset.vm0EditorSelected;
  }
  state.selected = null;
  state.selectionMutationObserver?.disconnect();
  state.selectionResizeObserver?.disconnect();
  state.selectionOverlay.hidden = true;
}

function selectMoveCandidate(
  state: MovableFrameState,
  candidate: HTMLElement,
): void {
  if (state.selected === candidate) {
    updateMoveSelectionOverlay(state);
    return;
  }
  clearMoveSelection(state);
  state.selected = candidate;
  state.selected.dataset.vm0EditorSelected = "true";
  observeMoveSelection(state);
  updateMoveSelectionOverlay(state);
}

function wireMoveSelectionTracking(
  doc: Document,
  state: MovableFrameState,
): () => void {
  const view = doc.defaultView;
  if (!view) {
    return () => {
      clearMoveSelection(state);
      state.selectionOverlay.remove();
    };
  }
  if (typeof view.ResizeObserver !== "undefined") {
    state.selectionResizeObserver = new view.ResizeObserver(() => {
      queueMoveSelectionOverlayUpdate(state);
    });
  }
  if (typeof view.MutationObserver !== "undefined") {
    state.selectionMutationObserver = new view.MutationObserver((records) => {
      const layoutChanged = records.some((record) => {
        return !state.selectionOverlay.contains(record.target);
      });
      if (layoutChanged) {
        queueMoveSelectionOverlayUpdate(state);
      }
    });
  }
  const updateOverlay = () => {
    queueMoveSelectionOverlayUpdate(state);
  };
  view.addEventListener("resize", updateOverlay);
  doc.addEventListener("scroll", updateOverlay, true);
  doc.addEventListener("load", updateOverlay, true);
  doc.fonts?.addEventListener("loadingdone", updateOverlay);
  return () => {
    view.removeEventListener("resize", updateOverlay);
    doc.removeEventListener("scroll", updateOverlay, true);
    doc.removeEventListener("load", updateOverlay, true);
    doc.fonts?.removeEventListener("loadingdone", updateOverlay);
    state.selectionMutationObserver?.disconnect();
    state.selectionMutationObserver = null;
    state.selectionResizeObserver?.disconnect();
    state.selectionResizeObserver = null;
    if (state.selectionOverlayFrame !== null) {
      view.cancelAnimationFrame(state.selectionOverlayFrame);
      state.selectionOverlayFrame = null;
    }
    clearMoveSelection(state);
    state.selectionOverlay.remove();
  };
}

function finishMovableTextEditing(
  params: WireMovableFrameParams,
  state: MovableFrameState,
  element: HTMLElement,
): void {
  params.syncText(element);
  element.setAttribute("contenteditable", "false");
  if (state.textEditing === element) {
    state.textEditing = null;
  }
  updateMoveSelectionOverlay(state);
}

function wireMovableTextEditing(
  params: WireMovableFrameParams,
  state: MovableFrameState,
): () => void {
  const cleanupListeners: (() => void)[] = [];
  for (const element of Array.from(
    params.doc.querySelectorAll<HTMLElement>(EDITOR_TEXT_SELECTOR),
  )) {
    element.setAttribute("contenteditable", "false");
    element.setAttribute("role", "textbox");
    element.spellcheck = false;
    const startEditing = (event: MouseEvent) => {
      const candidate = element.closest<HTMLElement>(EDITOR_MOVE_SELECTOR);
      if (candidate) {
        selectMoveCandidate(state, candidate);
      }
      state.textEditing = element;
      element.setAttribute("contenteditable", "true");
      element.focus();
      event.stopPropagation();
    };
    const syncElement = () => {
      params.syncText(element);
      updateMoveSelectionOverlay(state);
    };
    const finishEditing = () => {
      finishMovableTextEditing(params, state, element);
    };
    const stopEditing = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        element.blur();
      }
    };
    element.addEventListener("dblclick", startEditing);
    element.addEventListener("input", syncElement);
    element.addEventListener("blur", finishEditing);
    element.addEventListener("keydown", stopEditing);
    cleanupListeners.push(() => {
      element.removeEventListener("dblclick", startEditing);
      element.removeEventListener("input", syncElement);
      element.removeEventListener("blur", finishEditing);
      element.removeEventListener("keydown", stopEditing);
    });
  }
  return () => {
    for (const cleanup of cleanupListeners) {
      cleanup();
    }
  };
}

function wireMoveSelection(
  params: WireMovableFrameParams,
  state: MovableFrameState,
): () => void {
  const selectCandidate = (event: MouseEvent) => {
    const candidate = closestFrameElement(event.target, EDITOR_MOVE_SELECTOR);
    if (candidate) {
      selectMoveCandidate(state, candidate);
      return;
    }
    clearMoveSelection(state);
  };
  params.doc.addEventListener("click", selectCandidate);
  return () => {
    params.doc.removeEventListener("click", selectCandidate);
  };
}

function startPointerDrag(
  params: WireMovableFrameParams,
  state: MovableFrameState,
  event: PointerEvent,
): void {
  if (event.button !== 0 || state.textEditing) {
    return;
  }
  const candidate = closestFrameElement(event.target, EDITOR_MOVE_SELECTOR);
  const moveId = candidate?.dataset.vm0EditorMoveId;
  const layout = candidate?.parentElement;
  const slide =
    layout?.closest<HTMLElement>(EDITOR_SLIDE_SELECTOR) ??
    (layout === params.doc.body ? layout : null);
  if (!candidate || !moveId || !layout || !slide) {
    return;
  }
  const layoutRect = layout.getBoundingClientRect();
  const candidateRect = candidate.getBoundingClientRect();
  const slideRect = slide.getBoundingClientRect();
  if (
    layoutRect.width <= 0 ||
    layoutRect.height <= 0 ||
    candidateRect.width <= 0 ||
    candidateRect.height <= 0
  ) {
    return;
  }
  const block = state.offsets.get(moveId);
  const initialOffsetX = block?.offsetX ?? 0;
  const initialOffsetY = block?.offsetY ?? 0;
  const initialTranslate = candidate.style.getPropertyValue("translate");
  const initialPixel = appliedCandidatePixelTranslate(candidate);
  selectMoveCandidate(state, candidate);
  candidate.setPointerCapture(event.pointerId);
  state.pointerDrag = {
    baseBottom: candidateRect.bottom - initialPixel.y,
    baseLeft: candidateRect.left - initialPixel.x,
    baseRight: candidateRect.right - initialPixel.x,
    baseTop: candidateRect.top - initialPixel.y,
    candidate,
    currentOffsetX: initialOffsetX,
    currentOffsetY: initialOffsetY,
    dragging: false,
    initialOffsetX,
    initialOffsetY,
    initialPixelX: initialPixel.x,
    initialPixelY: initialPixel.y,
    initialTranslate,
    layoutHeight: layoutRect.height,
    layoutWidth: layoutRect.width,
    moveId,
    pointerId: event.pointerId,
    slideRect,
    startX: event.clientX,
    startY: event.clientY,
  };
}

function updatePointerDrag(
  state: MovableFrameState,
  event: PointerEvent,
): void {
  const drag = state.pointerDrag;
  if (!drag || drag.pointerId !== event.pointerId) {
    return;
  }
  const deltaX = event.clientX - drag.startX;
  const deltaY = event.clientY - drag.startY;
  if (!drag.dragging && Math.hypot(deltaX, deltaY) < DRAG_START_THRESHOLD) {
    return;
  }
  drag.dragging = true;
  event.preventDefault();
  const pixelX = clampDragAxis(
    drag.initialPixelX + deltaX,
    drag.slideRect.left - drag.baseLeft,
    drag.slideRect.right - drag.baseRight,
  );
  const pixelY = clampDragAxis(
    drag.initialPixelY + deltaY,
    drag.slideRect.top - drag.baseTop,
    drag.slideRect.bottom - drag.baseBottom,
  );
  drag.currentOffsetX = pixelX / drag.layoutWidth;
  drag.currentOffsetY = pixelY / drag.layoutHeight;
  setCandidateTranslate(drag, drag.currentOffsetX, drag.currentOffsetY);
  updateMoveSelectionOverlay(state);
}

function releasePointerCapture(
  drag: PresentationPointerDrag,
  pointerId: number,
): void {
  if (drag.candidate.hasPointerCapture(pointerId)) {
    drag.candidate.releasePointerCapture(pointerId);
  }
}

function commitPointerDrag(
  params: WireMovableFrameParams,
  state: MovableFrameState,
  event: PointerEvent,
): void {
  const drag = state.pointerDrag;
  if (!drag || drag.pointerId !== event.pointerId) {
    return;
  }
  releasePointerCapture(drag, event.pointerId);
  state.pointerDrag = null;
  const offsetX = normalizePresentationElementOffset(drag.currentOffsetX);
  const offsetY = normalizePresentationElementOffset(drag.currentOffsetY);
  if (
    drag.dragging &&
    (offsetX !== drag.initialOffsetX || offsetY !== drag.initialOffsetY)
  ) {
    state.offsets.set(drag.moveId, { offsetX, offsetY });
    params.updateMovement(drag.moveId, offsetX, offsetY);
  }
}

function cancelPointerDrag(
  state: MovableFrameState,
  event: PointerEvent,
): void {
  const drag = state.pointerDrag;
  if (!drag || drag.pointerId !== event.pointerId) {
    return;
  }
  releasePointerCapture(drag, event.pointerId);
  if (drag.initialTranslate) {
    drag.candidate.style.setProperty("translate", drag.initialTranslate);
  } else {
    drag.candidate.style.removeProperty("translate");
  }
  updateMoveSelectionOverlay(state);
  state.pointerDrag = null;
}

function wireMovablePointerEvents(
  params: WireMovableFrameParams,
  state: MovableFrameState,
): () => void {
  const startDrag = (event: PointerEvent) => {
    startPointerDrag(params, state, event);
  };
  const updateDrag = (event: PointerEvent) => {
    updatePointerDrag(state, event);
  };
  const commitDrag = (event: PointerEvent) => {
    commitPointerDrag(params, state, event);
  };
  const cancelDrag = (event: PointerEvent) => {
    cancelPointerDrag(state, event);
  };
  params.doc.addEventListener("pointerdown", startDrag);
  params.doc.addEventListener("pointermove", updateDrag);
  params.doc.addEventListener("pointerup", commitDrag);
  params.doc.addEventListener("pointercancel", cancelDrag);
  return () => {
    params.doc.removeEventListener("pointerdown", startDrag);
    params.doc.removeEventListener("pointermove", updateDrag);
    params.doc.removeEventListener("pointerup", commitDrag);
    params.doc.removeEventListener("pointercancel", cancelDrag);
  };
}

function wireMovableFrame(params: WireMovableFrameParams): () => void {
  const state = createMovableFrameState(params.doc, params.moveBlocks);
  removeUnsupportedMoveCandidates(params.doc);
  const cleanupSelectionTracking = wireMoveSelectionTracking(params.doc, state);
  const cleanupTextEditing = wireMovableTextEditing(params, state);
  const cleanupMoveSelection = wireMoveSelection(params, state);
  const cleanupPointerEvents = wireMovablePointerEvents(params, state);
  return () => {
    cleanupTextEditing();
    cleanupMoveSelection();
    cleanupPointerEvents();
    cleanupSelectionTracking();
  };
}

function wireEditableFrame(params: {
  readonly frame: HTMLIFrameElement;
  readonly movementEnabled: boolean;
  readonly moveBlocks: readonly PresentationMoveBlock[];
  readonly updateText: (slideId: string, editId: string, text: string) => void;
  readonly updateMovement: (
    moveId: string,
    offsetX: number,
    offsetY: number,
  ) => void;
}): (() => void) | null {
  const doc = params.frame.contentDocument;
  if (!doc) {
    return null;
  }
  const syncText = (element: HTMLElement) => {
    const slideId = element.dataset.vm0EditorSlideId;
    const editId = element.dataset.vm0EditorEditId;
    if (!slideId || !editId) {
      return;
    }
    params.updateText(slideId, editId, element.textContent ?? "");
  };
  if (!params.movementEnabled) {
    return wireLegacyTextEditing({ doc, syncText });
  }
  return wireMovableFrame({
    doc,
    moveBlocks: params.moveBlocks,
    syncText,
    updateMovement: params.updateMovement,
  });
}

function PreviewPane({
  html,
  iframeRef,
  movementEnabled,
  moveBlocksRef,
  updateMovement,
  updateText,
}: {
  html: string | null;
  iframeRef: MutableValue<HTMLIFrameElement | null>;
  movementEnabled: boolean;
  moveBlocksRef: MutableValue<readonly PresentationMoveBlock[]>;
  updateMovement: (moveId: string, offsetX: number, offsetY: number) => void;
  updateText: (slideId: string, editId: string, text: string) => void;
}) {
  const frameCleanupRef = mutableValue<(() => void) | null>(null);
  const observerRef = mutableValue<ResizeObserver | null>(null);
  const shellRef = mutableValue<HTMLDivElement | null>(null);
  const scaleRef = mutableValue(0.6);
  const applyScale = () => {
    const shell = shellRef.current;
    const frame = iframeRef.current;
    if (!shell || !frame) {
      return;
    }
    shell.style.width = `${PREVIEW_CANVAS_WIDTH * scaleRef.current}px`;
    shell.style.height = `${PREVIEW_CANVAS_HEIGHT * scaleRef.current}px`;
    frame.style.transform = `scale(${scaleRef.current})`;
  };
  const setStageRef = (node: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) {
      return;
    }
    const updateScale = (width: number, height: number) => {
      scaleRef.current = Math.max(
        0.1,
        Math.min(
          width / PREVIEW_CANVAS_WIDTH,
          height / PREVIEW_CANVAS_HEIGHT,
          1,
        ) * PREVIEW_FIT_SCALE,
      );
      applyScale();
    };
    updateScale(node.clientWidth, node.clientHeight);
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) {
        return;
      }
      updateScale(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(node);
    observerRef.current = observer;
  };
  return (
    <main
      data-testid="presentation-editor-preview-pane"
      className="flex min-h-0 items-center justify-center overflow-hidden bg-white p-3 sm:p-4"
    >
      <div
        ref={setStageRef}
        className="flex h-full w-full items-center justify-center overflow-hidden bg-white"
      >
        <div
          ref={shellRef}
          className="relative bg-white shadow-[0_2px_10px_rgba(15,23,42,0.12)]"
        >
          {html && (
            <iframe
              ref={(frame) => {
                if (!frame) {
                  frameCleanupRef.current?.();
                  frameCleanupRef.current = null;
                }
                iframeRef.current = frame;
                if (frame) {
                  setSandboxedFrameHtml(frame, html);
                }
              }}
              title="Presentation preview"
              sandbox="allow-same-origin allow-scripts"
              onLoad={(event) => {
                applyScale();
                revealPresentationPreviewSlide(event);
                frameCleanupRef.current?.();
                frameCleanupRef.current = wireEditableFrame({
                  frame: event.currentTarget,
                  movementEnabled,
                  moveBlocks: moveBlocksRef.current,
                  updateMovement,
                  updateText,
                });
              }}
              className="absolute left-0 top-0 origin-top-left border-0 bg-white"
              style={{
                width: PREVIEW_CANVAS_WIDTH,
                height: PREVIEW_CANVAS_HEIGHT,
                transform: `scale(${scaleRef.current})`,
              }}
            />
          )}
        </div>
      </div>
    </main>
  );
}

function UnsupportedPresentation() {
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
      This presentation has no text nodes that can be edited.
    </div>
  );
}

function downloadEditedPptx(params: {
  baseUrl: string;
  filename: string;
  html: string;
  signal: AbortSignal;
}) {
  detach(
    tapError(downloadPresentationHtmlStringPptx(params), (error) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        toast.error("PPTX download failed");
      }
    }),
    Reason.DomCallback,
    "presentation html editor pptx download",
  );
}

function buildPresentationEditorHtml(params: {
  readonly blocks: readonly PresentationEditBlock[];
  readonly html: string;
  readonly moveBlocks: readonly PresentationMoveBlock[];
  readonly slides: readonly PresentationSlideDraft[];
}) {
  return patchPresentationHtml({
    blocks: params.blocks,
    html: params.html,
    moveBlocks: params.moveBlocks,
    slides: params.slides,
  });
}

function setEditorStatus(
  statusRef: MutableValue<HTMLDivElement | null>,
  value: string,
) {
  const text = statusRef.current?.querySelector("span");
  if (text) {
    text.textContent = value;
  }
}

function createPresentationEditorStatusRef(
  statusRef: MutableValue<HTMLDivElement | null>,
  draggingUnsupported: boolean,
): Ref<HTMLDivElement> {
  return (node) => {
    statusRef.current = node;
    if (draggingUnsupported && node) {
      setEditorStatus(statusRef, "Dragging unavailable for this presentation");
    }
  };
}

function setEditorActionsDisabled(disabled: boolean) {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    '[data-presentation-editor-action="true"]',
  )) {
    button.disabled = disabled;
  }
}

function setSpeakerNotesGenerating(generating: boolean) {
  const action = document.querySelector<HTMLButtonElement>(
    '[data-presentation-speaker-notes-action="true"]',
  );
  if (!action) {
    return;
  }
  const idleLabel = action.querySelector<HTMLElement>(
    "[data-speaker-notes-idle]",
  );
  const generatingLabel = action.querySelector<HTMLElement>(
    "[data-speaker-notes-generating]",
  );
  action.dataset.generating = generating ? "true" : "false";
  const label = generating
    ? "Generating speaker notes"
    : "Generate speaker notes";
  action.setAttribute("aria-label", label);
  action.title = label;
  idleLabel?.classList.toggle("sm:inline", !generating);
  generatingLabel?.classList.toggle("sm:inline-flex", generating);
}

function setEditorPublishing(params: {
  readonly busyRef: MutableValue<SVGSVGElement | null>;
  readonly publishing: boolean;
  readonly publishingRef: MutableValue<boolean>;
}) {
  params.publishingRef.current = params.publishing;
  setEditorActionsDisabled(params.publishing);
  params.busyRef.current?.classList.toggle("hidden", !params.publishing);
}

function showPresentationSlide(params: {
  readonly buildEditedHtml: () => string;
  readonly movementEnabled: boolean;
  readonly previewFrameRef: MutableValue<HTMLIFrameElement | null>;
  readonly slideId: string;
  readonly sourceUrl: string;
}) {
  for (const button of document.querySelectorAll<HTMLElement>(
    "[data-slide-id]",
  )) {
    button.dataset.active =
      button.dataset.slideId === params.slideId ? "true" : "false";
  }
  for (const label of document.querySelectorAll<HTMLElement>(
    "[data-slide-index-label]",
  )) {
    const active = label.dataset.slideIndexLabel === params.slideId;
    label.classList.toggle("bg-[#0f82ff]", active);
    label.classList.toggle("text-white", active);
    label.classList.toggle("text-[#858585]", !active);
  }
  if (params.previewFrameRef.current) {
    setSandboxedFrameHtml(
      params.previewFrameRef.current,
      previewPresentationHtml({
        activeSlideId: params.slideId,
        html: params.buildEditedHtml(),
        movementEditingEnabled: params.movementEnabled,
        sourceUrl: params.sourceUrl,
      }),
    );
  }
}

function updateSlideThumbnail(params: {
  readonly buildEditedHtml: () => string;
  readonly slideId: string;
  readonly sourceUrl: string;
}) {
  const thumbnailFrame = Array.from(
    document.querySelectorAll<HTMLIFrameElement>(
      "[data-slide-thumbnail-frame]",
    ),
  ).find((frame) => {
    return frame.dataset.slideThumbnailFrame === params.slideId;
  });
  if (thumbnailFrame) {
    setSandboxedFrameHtml(
      thumbnailFrame,
      previewPresentationHtml({
        activeSlideId: params.slideId,
        html: params.buildEditedHtml(),
        sourceUrl: params.sourceUrl,
      }),
    );
  }
}

function syncNotesPanel(slide: PresentationSlideDraft | undefined): void {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    "[data-presentation-notes-input]",
  );
  if (textarea) {
    textarea.dataset.presentationNotesSlideId = slide?.id ?? "";
    if (textarea.value !== (slide?.notes ?? "")) {
      textarea.value = slide?.notes ?? "";
    }
  }
}

async function ensurePresentationRedeployed(params: {
  readonly buildEditedHtml: () => string;
  readonly createClient: ZeroClientFactory;
  readonly currentSignature: () => string;
  readonly draft: EditorDraft;
  readonly markDirty: () => void;
  readonly pageSignal: AbortSignal;
  readonly publishedSignatureRef: MutableValue<string>;
  readonly publishedUrlRef: MutableValue<string | null>;
  readonly refreshPresentationHtmlPreviews: () => void;
  readonly setPublishing: (publishing: boolean) => void;
  readonly setStatus: (value: string) => void;
}): Promise<boolean> {
  const signature = params.currentSignature();
  if (signature === params.publishedSignatureRef.current) {
    return true;
  }
  params.setPublishing(true);
  params.setStatus("Publishing changes");
  const publish = async () => {
    const publishedUrl = await redeployPresentationHtml({
      createClient: params.createClient,
      html: params.buildEditedHtml(),
      publicUrl: params.publishedUrlRef.current ?? params.draft.publicUrl,
      signal: params.pageSignal,
    });
    params.publishedUrlRef.current = publishedUrl;
    params.refreshPresentationHtmlPreviews();
    params.publishedSignatureRef.current = signature;
    toast.success("Presentation updated");
    return true;
  };
  const published = await tapError(
    publish().finally(() => {
      params.setPublishing(false);
      params.markDirty();
    }),
    (error) => {
      if (!(error instanceof ApiError)) {
        toast.error(
          error instanceof Error ? error.message : "Presentation update failed",
        );
      }
    },
  );
  return published ?? false;
}

function runEditorTaskIfIdle(params: {
  readonly publishingRef: MutableValue<boolean>;
  readonly reason: string;
  readonly task: () => Promise<void>;
}) {
  if (params.publishingRef.current) {
    return;
  }
  detach(params.task(), Reason.DomCallback, params.reason);
}

function PresentationEditorWorkspace({
  activeSlide,
  activeSlideId,
  blocksRef,
  movementEnabled,
  moveBlocksRef,
  markDirty,
  previewFrameRef,
  previewHtml,
  queueSlideThumbnailUpdate,
  showSlide,
  slideList,
  slidesRef,
  slides,
}: {
  activeSlide: PresentationSlideDraft | undefined;
  activeSlideId: string;
  blocksRef: MutableValue<readonly PresentationEditBlock[]>;
  movementEnabled: boolean;
  moveBlocksRef: MutableValue<readonly PresentationMoveBlock[]>;
  markDirty: () => void;
  previewFrameRef: MutableValue<HTMLIFrameElement | null>;
  previewHtml: string | null;
  queueSlideThumbnailUpdate: (slideId: string) => void;
  showSlide: (slideId: string) => void;
  slideList: PresentationSlideListSignals;
  slidesRef: MutableValue<readonly PresentationSlideDraft[]>;
  slides: readonly PresentationSlideDraft[];
}) {
  if (slides.length === 0 || !activeSlide) {
    return <UnsupportedPresentation />;
  }

  return (
    <div
      data-testid="presentation-editor-workspace"
      className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden md:grid-cols-[260px_minmax(0,1fr)] md:grid-rows-1"
    >
      <SlideList
        activeSlideId={activeSlideId}
        setActiveSlideId={showSlide}
        signals={slideList}
        slides={slides}
      />
      <div
        data-testid="presentation-editor-main-pane"
        className="grid min-h-0 grid-rows-[minmax(0,1fr)_136px] overflow-hidden md:grid-rows-[minmax(0,1fr)_180px]"
      >
        <PreviewPane
          html={previewHtml}
          iframeRef={previewFrameRef}
          movementEnabled={movementEnabled}
          moveBlocksRef={moveBlocksRef}
          updateMovement={(moveId, rawOffsetX, rawOffsetY) => {
            const block = moveBlocksRef.current.find((candidate) => {
              return candidate.moveId === moveId;
            });
            if (!block) {
              return;
            }
            const offsetX = normalizePresentationElementOffset(rawOffsetX);
            const offsetY = normalizePresentationElementOffset(rawOffsetY);
            if (block.offsetX === offsetX && block.offsetY === offsetY) {
              return;
            }
            moveBlocksRef.current = updateMoveBlock(
              moveBlocksRef.current,
              moveId,
              offsetX,
              offsetY,
            );
            markDirty();
            queueSlideThumbnailUpdate(block.slideId);
          }}
          updateText={(slideId, editId, text) => {
            const block = blocksRef.current.find((candidate) => {
              return (
                candidate.slideId === slideId && candidate.editId === editId
              );
            });
            if (block) {
              blocksRef.current = updateBlockText(
                blocksRef.current,
                block,
                text,
              );
              markDirty();
              queueSlideThumbnailUpdate(slideId);
            }
          }}
        />
        <section className="flex min-h-0 flex-col border-t border-border/60 bg-background">
          <textarea
            aria-label="Speaker notes"
            data-presentation-notes-input="true"
            data-presentation-notes-slide-id={activeSlide.id}
            defaultValue={activeSlide.notes}
            placeholder="Add speaker notes"
            spellCheck={false}
            onChange={(event) => {
              const slideId =
                event.currentTarget.dataset.presentationNotesSlideId;
              if (!slideId) {
                return;
              }
              slidesRef.current = updateSlideNotes(
                slidesRef.current,
                slideId,
                event.currentTarget.value,
              );
              markDirty();
            }}
            className="min-h-0 flex-1 resize-none bg-background px-4 py-3 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground focus:bg-muted/20"
          />
        </section>
      </div>
    </div>
  );
}

async function runFillEmptySpeakerNotes(ctx: {
  readonly buildEditedHtml: () => string;
  readonly markDirty: () => void;
  readonly params: {
    readonly activeSlideIdRef: MutableValue<string>;
    readonly createClient: ZeroClientFactory;
    readonly pageSignal: AbortSignal;
    readonly slidesRef: MutableValue<readonly PresentationSlideDraft[]>;
  };
  readonly setPublishing: (publishing: boolean) => void;
  readonly setStatus: (value: string) => void;
}): Promise<void> {
  const { params } = ctx;
  if (
    !params.slidesRef.current.some((slide) => {
      return slide.notes.trim().length === 0;
    })
  ) {
    toast.info("All speaker notes are filled");
    return;
  }

  ctx.setPublishing(true);
  setSpeakerNotesGenerating(true);
  ctx.setStatus("Generating speaker notes");
  const generated = await tapError(
    generatePresentationSpeakerNotes({
      createClient: params.createClient,
      html: ctx.buildEditedHtml(),
      signal: params.pageSignal,
    }).finally(() => {
      setSpeakerNotesGenerating(false);
      ctx.setPublishing(false);
    }),
    (error) => {
      if (!(error instanceof ApiError)) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Speaker notes generation failed",
        );
      }
    },
  );
  if (!generated) {
    return;
  }

  const result = applyPresentationSpeakerNotesPatch({
    patch: generated,
    slides: params.slidesRef.current,
  });
  if (result.appliedCount === 0) {
    toast.info("No speaker notes were added");
    return;
  }

  params.slidesRef.current = result.slides;
  syncNotesPanel(
    params.slidesRef.current.find((slide) => {
      return slide.id === params.activeSlideIdRef.current;
    }),
  );
  ctx.markDirty();
  toast.success(
    `Added speaker notes to ${String(result.appliedCount)} slide${
      result.appliedCount === 1 ? "" : "s"
    }`,
  );
}

function buildActiveSlidePreviewHtml(
  activeSlideId: string,
  buildEditedHtml: () => string,
  movementEnabled: boolean,
  sourceUrl: string,
): string | null {
  return activeSlideId.length > 0
    ? previewPresentationHtml({
        activeSlideId,
        html: buildEditedHtml(),
        movementEditingEnabled: movementEnabled,
        sourceUrl,
      })
    : null;
}

interface PresentationEditorControllerParams {
  readonly activeSlideIdRef: MutableValue<string>;
  readonly blocksRef: MutableValue<readonly PresentationEditBlock[]>;
  readonly busyRef: MutableValue<SVGSVGElement | null>;
  readonly createClient: ZeroClientFactory;
  readonly draft: EditorDraft;
  readonly movementEnabled: boolean;
  readonly pageSignal: AbortSignal;
  readonly pendingThumbnailSlideIdRef: MutableValue<string | null>;
  readonly previewFrameRef: MutableValue<HTMLIFrameElement | null>;
  readonly publishedSignatureRef: MutableValue<string>;
  readonly publishedUrlRef: MutableValue<string | null>;
  readonly publishingRef: MutableValue<boolean>;
  readonly moveBlocksRef: MutableValue<readonly PresentationMoveBlock[]>;
  readonly refreshPresentationHtmlPreviews: () => void;
  readonly slidesRef: MutableValue<readonly PresentationSlideDraft[]>;
  readonly sourceUrl: string;
  readonly statusRef: MutableValue<HTMLDivElement | null>;
  readonly thumbnailUpdateFrameRef: MutableValue<number | null>;
}

function createPresentationEditorController(
  params: PresentationEditorControllerParams,
) {
  const slides = params.slidesRef.current;
  const activeSlideId = params.activeSlideIdRef.current;
  const activeSlide = slides.find((slide) => {
    return slide.id === activeSlideId;
  });
  const buildEditedHtml = () => {
    return buildPresentationEditorHtml({
      blocks: params.blocksRef.current,
      html: params.draft.html,
      moveBlocks: params.moveBlocksRef.current,
      slides: params.slidesRef.current,
    });
  };
  const currentSignature = () => {
    return editSignature({
      blocks: params.blocksRef.current,
      moveBlocks: params.moveBlocksRef.current,
      slides: params.slidesRef.current,
    });
  };
  const setStatus = (value: string) => {
    setEditorStatus(params.statusRef, value);
  };
  const setPublishing = (publishing: boolean) => {
    setEditorPublishing({
      busyRef: params.busyRef,
      publishing,
      publishingRef: params.publishingRef,
    });
  };
  const hasUnsavedChanges = () => {
    return currentSignature() !== params.publishedSignatureRef.current;
  };
  const markDirty = () => {
    setStatus(hasUnsavedChanges() ? "Unsaved changes" : "Presentation editor");
  };
  const queueSlideThumbnailUpdate = (slideId: string) => {
    params.pendingThumbnailSlideIdRef.current = slideId;
    if (params.thumbnailUpdateFrameRef.current !== null) {
      return;
    }
    params.thumbnailUpdateFrameRef.current = window.requestAnimationFrame(
      () => {
        params.thumbnailUpdateFrameRef.current = null;
        const pendingSlideId = params.pendingThumbnailSlideIdRef.current;
        params.pendingThumbnailSlideIdRef.current = null;
        if (pendingSlideId) {
          updateSlideThumbnail({
            buildEditedHtml,
            slideId: pendingSlideId,
            sourceUrl: params.draft.publicUrl,
          });
        }
      },
    );
  };
  const ensureRedeployed = (): Promise<boolean> => {
    if (params.publishingRef.current) {
      return Promise.resolve(false);
    }
    return ensurePresentationRedeployed({
      buildEditedHtml,
      createClient: params.createClient,
      currentSignature,
      draft: params.draft,
      markDirty,
      pageSignal: params.pageSignal,
      publishedSignatureRef: params.publishedSignatureRef,
      publishedUrlRef: params.publishedUrlRef,
      refreshPresentationHtmlPreviews: params.refreshPresentationHtmlPreviews,
      setPublishing,
      setStatus,
    });
  };
  const fillEmptySpeakerNotes = () => {
    return runFillEmptySpeakerNotes({
      buildEditedHtml,
      markDirty,
      params,
      setPublishing,
      setStatus,
    });
  };
  const showSlide = (slideId: string) => {
    params.activeSlideIdRef.current = slideId;
    syncNotesPanel(
      params.slidesRef.current.find((slide) => {
        return slide.id === slideId;
      }),
    );
    showPresentationSlide({
      buildEditedHtml,
      movementEnabled: params.movementEnabled,
      previewFrameRef: params.previewFrameRef,
      slideId,
      sourceUrl: params.draft.publicUrl,
    });
  };
  const previewHtml = buildActiveSlidePreviewHtml(
    activeSlideId,
    buildEditedHtml,
    params.movementEnabled,
    params.draft.publicUrl,
  );

  return {
    activeSlide,
    activeSlideId,
    buildEditedHtml,
    ensureRedeployed,
    fillEmptySpeakerNotes,
    hasUnsavedChanges,
    markDirty,
    previewHtml,
    queueSlideThumbnailUpdate,
    showSlide,
    slides,
  };
}

function createPresentationEditorCloseActions(params: {
  readonly controller: ReturnType<typeof createPresentationEditorController>;
  readonly draft: EditorDraft;
  readonly onClose: (publishedUrl?: string) => void;
  readonly publishingRef: MutableValue<boolean>;
  readonly setCloseDialogOpen: (open: boolean) => void;
}) {
  const requestClose = () => {
    if (!params.controller.hasUnsavedChanges()) {
      params.onClose(
        params.draft.editorSession.publishedUrlRef.current ?? undefined,
      );
      return;
    }
    params.setCloseDialogOpen(true);
  };
  const exitWithoutSaving = () => {
    params.setCloseDialogOpen(false);
    params.onClose(
      params.draft.editorSession.publishedUrlRef.current ?? undefined,
    );
  };
  const saveAndClose = () => {
    params.setCloseDialogOpen(false);
    runEditorTaskIfIdle({
      publishingRef: params.publishingRef,
      reason: "presentation html editor close",
      task: async () => {
        if (await params.controller.ensureRedeployed()) {
          params.onClose(
            params.draft.editorSession.publishedUrlRef.current ?? undefined,
          );
        }
      },
    });
  };
  return { exitWithoutSaving, requestClose, saveAndClose };
}

function PresentationEditorCloseDialog({
  onExit,
  onOpenChange,
  onSave,
  open,
}: {
  readonly onExit: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: () => void;
  readonly open: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="zero-app !z-[10000] gap-5 sm:max-w-md"
        overlayClassName="!z-[10000]"
      >
        <DialogHeader>
          <DialogTitle className="whitespace-nowrap">
            Do you want to save your changes?
          </DialogTitle>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9 px-4 text-destructive hover:text-destructive"
            onClick={onExit}
          >
            Discard
          </Button>
          <Button type="button" size="sm" className="h-9 px-4" onClick={onSave}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function createEditedPptxDownloadAction(params: {
  readonly controller: ReturnType<typeof createPresentationEditorController>;
  readonly draft: EditorDraft;
  readonly enabled: boolean;
  readonly filename: string;
  readonly pageSignal: AbortSignal;
  readonly publishingRef: MutableValue<boolean>;
}): (() => void) | undefined {
  if (!params.enabled) {
    return undefined;
  }
  return () => {
    runEditorTaskIfIdle({
      publishingRef: params.publishingRef,
      reason: "presentation html editor pptx download after publish",
      task: async () => {
        if (!(await params.controller.ensureRedeployed())) {
          return;
        }
        downloadEditedPptx({
          baseUrl: params.draft.publicUrl,
          filename: params.filename,
          html: params.controller.buildEditedHtml(),
          signal: params.pageSignal,
        });
      },
    });
  };
}

function PresentationEditorReady({
  draggingUnsupported,
  draft,
  filename,
  movementEnabled,
  onClose,
  pptxExportEnabled,
  sourceUrl,
  title,
}: {
  draggingUnsupported: boolean;
  draft: EditorDraft;
  filename: string;
  movementEnabled: boolean;
  onClose: (publishedUrl?: string) => void;
  pptxExportEnabled: boolean;
  sourceUrl: string;
  title: string;
}) {
  const pageSignal = useGet(pageSignal$);
  const createClient = useGet(zeroClient$);
  const closeDialogOpen = useGet(presentationEditorCloseDialogOpen$);
  const setCloseDialogOpen = useSet(setPresentationEditorCloseDialogOpen$);
  const refreshPresentationHtmlPreviews = useSet(
    refreshPresentationHtmlPreviews$,
  );
  const {
    activeSlideIdRef,
    blocksRef,
    busyRef,
    pendingThumbnailSlideIdRef,
    previewFrameRef,
    publishedSignatureRef,
    publishedUrlRef,
    publishingRef,
    moveBlocksRef,
    slideList,
    slidesRef,
    statusRef,
    thumbnailUpdateFrameRef,
  } = draft.editorSession;
  const controller = createPresentationEditorController({
    activeSlideIdRef,
    blocksRef,
    busyRef,
    createClient,
    draft,
    movementEnabled,
    pageSignal,
    pendingThumbnailSlideIdRef,
    previewFrameRef,
    publishedSignatureRef,
    publishedUrlRef,
    publishingRef,
    moveBlocksRef,
    refreshPresentationHtmlPreviews,
    slidesRef,
    sourceUrl,
    statusRef,
    thumbnailUpdateFrameRef,
  });

  const closeActions = createPresentationEditorCloseActions({
    controller,
    draft,
    onClose,
    publishingRef,
    setCloseDialogOpen,
  });
  const downloadPptx = createEditedPptxDownloadAction({
    controller,
    draft,
    enabled: pptxExportEnabled,
    filename,
    pageSignal,
    publishingRef,
  });

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <PresentationEditorHeader
        busyRef={(node) => {
          busyRef.current = node;
        }}
        onClose={closeActions.requestClose}
        onDownloadPptx={downloadPptx}
        onGenerateSpeakerNotes={() => {
          runEditorTaskIfIdle({
            publishingRef,
            reason: "presentation html editor speaker notes generation",
            task: controller.fillEmptySpeakerNotes,
          });
        }}
        statusRef={createPresentationEditorStatusRef(
          statusRef,
          draggingUnsupported,
        )}
        title={title}
      />
      <PresentationEditorWorkspace
        activeSlide={controller.activeSlide}
        activeSlideId={controller.activeSlideId}
        blocksRef={blocksRef}
        movementEnabled={movementEnabled}
        moveBlocksRef={moveBlocksRef}
        markDirty={controller.markDirty}
        previewFrameRef={previewFrameRef}
        previewHtml={controller.previewHtml}
        queueSlideThumbnailUpdate={controller.queueSlideThumbnailUpdate}
        showSlide={controller.showSlide}
        slideList={slideList}
        slidesRef={slidesRef}
        slides={controller.slides}
      />
      <PresentationEditorCloseDialog
        open={closeDialogOpen}
        onExit={closeActions.exitWithoutSaving}
        onOpenChange={setCloseDialogOpen}
        onSave={closeActions.saveAndClose}
      />
    </div>
  );
}

export function PresentationHtmlEditor({
  onClose,
  url,
}: PresentationHtmlEditorProps) {
  const filename = attachmentFilenameFromUrl(url);
  const title = fallbackHtmlPreviewTitle(filename, url);
  const loadable = useLoadable(currentPresentationDraft$);
  const features = useGet(featureSwitch$);
  const movementFeatureEnabled = Boolean(
    features?.[FeatureSwitchKey.PresentationElementDragging],
  );
  const pptxExportEnabled = Boolean(
    features?.[FeatureSwitchKey.PresentationPptxExport],
  );

  if (loadable.state === "loading") {
    return <PresentationEditorLoading title={title} onClose={onClose} />;
  }
  if (loadable.state === "hasError") {
    const message =
      loadable.error instanceof Error
        ? loadable.error.message
        : "Failed to load presentation";
    return (
      <PresentationEditorError
        message={message}
        onClose={onClose}
        title={title}
      />
    );
  }
  return (
    <PresentationEditorReady
      key={url}
      draggingUnsupported={
        movementFeatureEnabled && !loadable.data.movementSupported
      }
      draft={loadable.data}
      filename={filename}
      movementEnabled={
        movementFeatureEnabled && loadable.data.movementSupported
      }
      onClose={onClose}
      pptxExportEnabled={pptxExportEnabled}
      sourceUrl={url}
      title={title}
    />
  );
}
