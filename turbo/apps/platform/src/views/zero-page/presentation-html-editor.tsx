import type { ReactNode, Ref } from "react";
import {
  IconDownload,
  IconFileTypeHtml,
  IconLoader2,
  IconPresentation,
  IconX,
} from "@tabler/icons-react";
import { zeroHostContract } from "@vm0/api-contracts/contracts/zero-host";
import { cn } from "@vm0/ui";
import { toast } from "@vm0/ui/components/ui/sonner";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { accept } from "../../lib/accept.ts";
import {
  zeroClient$,
  type ZeroClientFactory,
} from "../../signals/api-client.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { refreshPresentationHtmlPreviews$ } from "../../signals/zero-page/presentation-html-cache-bust.ts";
import { createPresentationDraftByUrlFactory } from "../../signals/zero-page/presentation-html-editor-draft.ts";
import { detach, Reason, tapError } from "../../signals/utils.ts";
import {
  downloadPresentationHtmlStringPptx,
  readablePresentationResourceUrl,
} from "./presentation-html-pptx-download.ts";
import {
  parsePresentationEditDraft,
  patchPresentationHtml,
  previewPresentationHtml,
  type PresentationEditBlock,
  type PresentationEditDraft,
  type PresentationSlideDraft,
} from "./presentation-html-edit-protocol.ts";
import {
  attachmentFilenameFromUrl,
  publicAttachmentUrl,
} from "./zero-attachment-url.ts";
import { fallbackHtmlPreviewTitle } from "./zero-attachment-preview.tsx";

interface PresentationHtmlEditorProps {
  readonly onClose: () => void;
  readonly url: string;
}

type EditorDraft = PresentationEditDraft & {
  readonly publicUrl: string;
};

interface MutableValue<T> {
  current: T;
}

function mutableValue<T>(current: T): MutableValue<T> {
  return { current };
}

const presentationDraftByUrl = createPresentationDraftByUrlFactory<EditorDraft>(
  async (url, signal) => {
    const publicUrl = publicAttachmentUrl(url);
    const response = await fetch(readablePresentationResourceUrl(publicUrl), {
      cache: "reload",
      mode: "cors",
      signal,
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch presentation HTML (${response.status})`);
    }
    const draft = parsePresentationEditDraft(await response.text());
    return { ...draft, publicUrl };
  },
);
const THUMBNAIL_CANVAS_WIDTH = 1920;
const THUMBNAIL_CANVAS_HEIGHT = 1080;
const THUMBNAIL_SCALE = 0.1125;
const PREVIEW_CANVAS_WIDTH = 1920;
const PREVIEW_CANVAS_HEIGHT = 1080;
const PREVIEW_FIT_SCALE = 0.99;

function setSandboxedFrameHtml(frame: HTMLIFrameElement, html: string): void {
  const previousUrl = frame.dataset.vm0EditorObjectUrl;
  if (previousUrl) {
    URL.revokeObjectURL(previousUrl);
  }
  const url = URL.createObjectURL(
    new Blob([html], { type: "text/html;charset=utf-8" }),
  );
  frame.dataset.vm0EditorObjectUrl = url;
  frame.src = url;
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
    { toast: false },
  );
  return completed.body.url;
}

function htmlFilename(filename: string): string {
  return filename.replace(/\.(html?|xhtml)$/i, "") + ".html";
}

function downloadHtml(html: string, filename: string): void {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = htmlFilename(filename);
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(anchor.href);
  }, 0);
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

function editSignature(params: {
  readonly blocks: readonly PresentationEditBlock[];
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
  onDownloadHtml,
  onDownloadPptx,
  statusRef,
  title,
}: {
  busyRef?: Ref<SVGSVGElement>;
  onClose: () => void;
  onDownloadHtml: (() => void) | undefined;
  onDownloadPptx: (() => void) | undefined;
  statusRef?: Ref<HTMLDivElement>;
  title: string;
}) {
  return (
    <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/60 bg-background px-4 py-2">
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
      <button
        type="button"
        data-presentation-editor-action="true"
        aria-label="Download edited HTML"
        disabled={!onDownloadHtml}
        onClick={onDownloadHtml}
        className="inline-flex h-8 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
      >
        <IconFileTypeHtml size={16} stroke={1.5} />
        HTML
      </button>
      <button
        type="button"
        data-presentation-editor-action="true"
        aria-label="Download edited PPTX"
        disabled={!onDownloadPptx}
        onClick={onDownloadPptx}
        className="inline-flex h-8 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
      >
        <IconDownload size={16} stroke={1.5} />
        PPTX
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
    <div className="flex h-full min-w-0 flex-1 flex-col bg-background">
      <PresentationEditorHeader
        onClose={onClose}
        onDownloadHtml={undefined}
        onDownloadPptx={undefined}
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
  getSlideHtml,
  setActiveSlideId,
  slides,
}: {
  activeSlideId: string;
  getSlideHtml: (slideId: string) => string | null;
  setActiveSlideId: (id: string) => void;
  slides: readonly PresentationSlideDraft[];
}) {
  const rootRef = mutableValue<HTMLElement | null>(null);
  const observerRef = mutableValue<IntersectionObserver | null>(null);
  const observedFramesRef = mutableValue(new WeakSet<HTMLIFrameElement>());
  const loadThumbnail = (frame: HTMLIFrameElement, slideId: string) => {
    const html = getSlideHtml(slideId);
    if (html) {
      setSandboxedFrameHtml(frame, html);
    }
  };
  const thumbnailObserver = () => {
    if (typeof IntersectionObserver === "undefined") {
      return null;
    }
    if (!observerRef.current) {
      observerRef.current = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!(entry.target instanceof HTMLIFrameElement)) {
              continue;
            }
            if (!entry.isIntersecting) {
              continue;
            }
            const slideId = entry.target.dataset.slideThumbnailFrame;
            if (slideId) {
              loadThumbnail(entry.target, slideId);
            }
            observerRef.current?.unobserve(entry.target);
          }
        },
        { root: rootRef.current, rootMargin: "480px 0px" },
      );
    }
    return observerRef.current;
  };
  const setThumbnailFrame = (
    frame: HTMLIFrameElement | null,
    slideId: string,
    active: boolean,
  ) => {
    if (!frame) {
      return;
    }
    if (active) {
      loadThumbnail(frame, slideId);
      return;
    }
    const observer = thumbnailObserver();
    if (!observer) {
      loadThumbnail(frame, slideId);
      return;
    }
    if (!observedFramesRef.current.has(frame)) {
      observedFramesRef.current.add(frame);
      observer.observe(frame);
    }
  };
  return (
    <aside
      ref={(node) => {
        rootRef.current = node;
      }}
      className="min-h-0 overflow-auto border-r border-border/60 bg-[#eeeeee] px-5 py-6"
    >
      <div className="space-y-6">
        {slides.map((slide, index) => {
          const active = slide.id === activeSlideId;
          return (
            <div key={slide.id} className="flex flex-col items-center gap-2">
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
                  ref={(frame) => {
                    setThumbnailFrame(frame, slide.id, active);
                  }}
                  title={`Slide ${String(index + 1)} thumbnail`}
                  data-slide-thumbnail-frame={slide.id}
                  sandbox="allow-same-origin allow-scripts"
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

function wireEditableFrame(params: {
  readonly frame: HTMLIFrameElement;
  readonly updateText: (slideId: string, editId: string, text: string) => void;
}) {
  const doc = params.frame.contentDocument;
  if (!doc) {
    return;
  }
  const syncText = (element: HTMLElement) => {
    const slideId = element.dataset.vm0EditorSlideId;
    const editId = element.dataset.vm0EditorEditId;
    if (!slideId || !editId) {
      return;
    }
    params.updateText(slideId, editId, element.textContent ?? "");
  };
  for (const element of Array.from(
    doc.querySelectorAll<HTMLElement>("[data-vm0-editor-edit-id]"),
  )) {
    element.setAttribute("contenteditable", "true");
    element.setAttribute("role", "textbox");
    element.spellcheck = false;
    const computedPosition =
      doc.defaultView?.getComputedStyle(element).position;
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
    element.addEventListener("pointerdown", () => {
      element.focus();
    });
    element.addEventListener("input", () => {
      syncText(element);
    });
    element.addEventListener("blur", () => {
      syncText(element);
    });
  }
}

function PreviewPane({
  html,
  iframeRef,
  updateText,
}: {
  html: string | null;
  iframeRef: MutableValue<HTMLIFrameElement | null>;
  updateText: (slideId: string, editId: string, text: string) => void;
}) {
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
    <main className="flex min-h-0 items-center justify-center overflow-hidden bg-white p-4">
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
                iframeRef.current = frame;
                if (frame) {
                  setSandboxedFrameHtml(frame, html);
                }
              }}
              title="Presentation preview"
              sandbox="allow-same-origin allow-scripts"
              onLoad={(event) => {
                applyScale();
                wireEditableFrame({
                  frame: event.currentTarget,
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
  readonly draft: EditorDraft;
  readonly slides: readonly PresentationSlideDraft[];
}) {
  return patchPresentationHtml({
    blocks: params.blocks,
    html: params.draft.html,
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

function setEditorActionsDisabled(disabled: boolean) {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    '[data-presentation-editor-action="true"]',
  )) {
    button.disabled = disabled;
  }
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
  readonly previewFrameRef: MutableValue<HTMLIFrameElement | null>;
  readonly slideId: string;
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
      }),
    );
  }
}

function updateSlideThumbnail(params: {
  readonly buildEditedHtml: () => string;
  readonly slideId: string;
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
      }),
    );
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
  readonly refreshPresentationHtmlPreviews: () => void;
  readonly setPublishing: (publishing: boolean) => void;
  readonly setStatus: (value: string) => void;
  readonly sourceUrl: string;
}): Promise<boolean> {
  const signature = params.currentSignature();
  if (signature === params.publishedSignatureRef.current) {
    return true;
  }
  params.setPublishing(true);
  params.setStatus("Publishing changes");
  const publish = async () => {
    await redeployPresentationHtml({
      createClient: params.createClient,
      html: params.buildEditedHtml(),
      publicUrl: params.draft.publicUrl,
      signal: params.pageSignal,
    });
    presentationDraftByUrl.invalidate(params.sourceUrl);
    presentationDraftByUrl.invalidate(params.draft.publicUrl);
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
      if (!(error instanceof DOMException && error.name === "AbortError")) {
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
  buildEditedHtml,
  markDirty,
  previewFrameRef,
  previewHtml,
  queueSlideThumbnailUpdate,
  showSlide,
  slides,
}: {
  activeSlide: PresentationSlideDraft | undefined;
  activeSlideId: string;
  blocksRef: MutableValue<readonly PresentationEditBlock[]>;
  buildEditedHtml: () => string;
  markDirty: () => void;
  previewFrameRef: MutableValue<HTMLIFrameElement | null>;
  previewHtml: string | null;
  queueSlideThumbnailUpdate: (slideId: string) => void;
  showSlide: (slideId: string) => void;
  slides: readonly PresentationSlideDraft[];
}) {
  if (slides.length === 0 || blocksRef.current.length === 0 || !activeSlide) {
    return <UnsupportedPresentation />;
  }
  const slidePreviewHtml = (slideId: string) => {
    return previewPresentationHtml({
      activeSlideId: slideId,
      html: buildEditedHtml(),
    });
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)] overflow-hidden">
      <SlideList
        activeSlideId={activeSlideId}
        getSlideHtml={slidePreviewHtml}
        setActiveSlideId={showSlide}
        slides={slides}
      />
      <PreviewPane
        html={previewHtml}
        iframeRef={previewFrameRef}
        updateText={(slideId, editId, text) => {
          const block = blocksRef.current.find((candidate) => {
            return candidate.slideId === slideId && candidate.editId === editId;
          });
          if (block) {
            blocksRef.current = updateBlockText(blocksRef.current, block, text);
            markDirty();
            queueSlideThumbnailUpdate(slideId);
          }
        }}
      />
    </div>
  );
}

function createPresentationEditorController(params: {
  readonly activeSlideIdRef: MutableValue<string>;
  readonly blocksRef: MutableValue<readonly PresentationEditBlock[]>;
  readonly busyRef: MutableValue<SVGSVGElement | null>;
  readonly createClient: ZeroClientFactory;
  readonly draft: EditorDraft;
  readonly pageSignal: AbortSignal;
  readonly pendingThumbnailSlideIdRef: MutableValue<string | null>;
  readonly previewFrameRef: MutableValue<HTMLIFrameElement | null>;
  readonly publishedSignatureRef: MutableValue<string>;
  readonly publishingRef: MutableValue<boolean>;
  readonly refreshPresentationHtmlPreviews: () => void;
  readonly sourceUrl: string;
  readonly statusRef: MutableValue<HTMLDivElement | null>;
  readonly thumbnailUpdateFrameRef: MutableValue<number | null>;
}) {
  const slides = params.draft.slides;
  const activeSlideId = params.activeSlideIdRef.current;
  const activeSlide = slides.find((slide) => {
    return slide.id === activeSlideId;
  });
  const buildEditedHtml = () => {
    return buildPresentationEditorHtml({
      blocks: params.blocksRef.current,
      draft: params.draft,
      slides,
    });
  };
  const currentSignature = () => {
    return editSignature({ blocks: params.blocksRef.current, slides });
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
  const markDirty = () => {
    setStatus(
      currentSignature() !== params.publishedSignatureRef.current
        ? "Unsaved changes"
        : "Presentation editor",
    );
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
          updateSlideThumbnail({ buildEditedHtml, slideId: pendingSlideId });
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
      refreshPresentationHtmlPreviews: params.refreshPresentationHtmlPreviews,
      setPublishing,
      setStatus,
      sourceUrl: params.sourceUrl,
    });
  };
  const showSlide = (slideId: string) => {
    params.activeSlideIdRef.current = slideId;
    showPresentationSlide({
      buildEditedHtml,
      previewFrameRef: params.previewFrameRef,
      slideId,
    });
  };
  const previewHtml =
    activeSlideId.length > 0
      ? previewPresentationHtml({
          activeSlideId,
          html: buildEditedHtml(),
        })
      : null;

  return {
    activeSlide,
    activeSlideId,
    buildEditedHtml,
    ensureRedeployed,
    markDirty,
    previewHtml,
    queueSlideThumbnailUpdate,
    showSlide,
    slides,
  };
}

function PresentationEditorReady({
  draft,
  filename,
  onClose,
  sourceUrl,
  title,
}: {
  draft: EditorDraft;
  filename: string;
  onClose: () => void;
  sourceUrl: string;
  title: string;
}) {
  const pageSignal = useGet(pageSignal$);
  const createClient = useGet(zeroClient$);
  const refreshPresentationHtmlPreviews = useSet(
    refreshPresentationHtmlPreviews$,
  );
  const initialSlides = draft.slides;
  const blocksRef = mutableValue<readonly PresentationEditBlock[]>(
    draft.blocks,
  );
  const activeSlideIdRef = mutableValue(initialSlides[0]?.id ?? "");
  const publishedSignatureRef = mutableValue(
    editSignature({ blocks: draft.blocks, slides: initialSlides }),
  );
  const publishingRef = mutableValue(false);
  const statusRef = mutableValue<HTMLDivElement | null>(null);
  const busyRef = mutableValue<SVGSVGElement | null>(null);
  const previewFrameRef = mutableValue<HTMLIFrameElement | null>(null);
  const thumbnailUpdateFrameRef = mutableValue<number | null>(null);
  const pendingThumbnailSlideIdRef = mutableValue<string | null>(null);
  const controller = createPresentationEditorController({
    activeSlideIdRef,
    blocksRef,
    busyRef,
    createClient,
    draft,
    pageSignal,
    pendingThumbnailSlideIdRef,
    previewFrameRef,
    publishedSignatureRef,
    publishingRef,
    refreshPresentationHtmlPreviews,
    sourceUrl,
    statusRef,
    thumbnailUpdateFrameRef,
  });

  const closeAfterPublish = () => {
    runEditorTaskIfIdle({
      publishingRef,
      reason: "presentation html editor close",
      task: async () => {
        if (await controller.ensureRedeployed()) {
          onClose();
        }
      },
    });
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <PresentationEditorHeader
        busyRef={(node) => {
          busyRef.current = node;
        }}
        onClose={closeAfterPublish}
        onDownloadHtml={() => {
          runEditorTaskIfIdle({
            publishingRef,
            reason: "presentation html editor html download",
            task: async () => {
              if (!(await controller.ensureRedeployed())) {
                return;
              }
              downloadHtml(controller.buildEditedHtml(), filename);
            },
          });
        }}
        onDownloadPptx={() => {
          runEditorTaskIfIdle({
            publishingRef,
            reason: "presentation html editor pptx download after publish",
            task: async () => {
              if (!(await controller.ensureRedeployed())) {
                return;
              }
              downloadEditedPptx({
                baseUrl: draft.publicUrl,
                filename,
                html: controller.buildEditedHtml(),
                signal: pageSignal,
              });
            },
          });
        }}
        statusRef={(node) => {
          statusRef.current = node;
        }}
        title={title}
      />
      <PresentationEditorWorkspace
        activeSlide={controller.activeSlide}
        activeSlideId={controller.activeSlideId}
        blocksRef={blocksRef}
        buildEditedHtml={controller.buildEditedHtml}
        markDirty={controller.markDirty}
        previewFrameRef={previewFrameRef}
        previewHtml={controller.previewHtml}
        queueSlideThumbnailUpdate={controller.queueSlideThumbnailUpdate}
        showSlide={controller.showSlide}
        slides={controller.slides}
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
  const loadable = useLoadable(presentationDraftByUrl.get(url));

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
      draft={loadable.data}
      filename={filename}
      onClose={onClose}
      sourceUrl={url}
      title={title}
    />
  );
}
