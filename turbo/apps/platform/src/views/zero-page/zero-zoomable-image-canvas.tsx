import type {
  MouseEvent as ReactMouseEvent,
  ReactNode,
  Ref,
  SyntheticEvent,
} from "react";
import { useGet, useSet } from "ccstate-react";
import { cn } from "@vm0/ui";
import {
  IMAGE_LIGHTBOX_MAX_ZOOM,
  IMAGE_LIGHTBOX_MIN_ZOOM,
  resetZoomableImageCanvasZoom$,
  setZoomableImageCanvasFitWidth$,
  setZoomableImageCanvasZoom$,
  zoomableImageCanvasFitWidthByKey$,
  zoomableImageCanvasWheelRef$,
  zoomableImageCanvasZoomByKey$,
} from "../../signals/view-component-state.ts";

const IMAGE_ZOOM_STEP = 0.15;

type ZoomableArtifactImageSurface =
  | "attachment-lightbox"
  | "artifact-dialog"
  | "artifact-sidebar";

export function zoomableArtifactImageKey(
  surface: ZoomableArtifactImageSurface,
  url: string,
  mode = "default",
) {
  return `${surface}:${mode}:${url}`;
}

type SetZoomHandler = (key: string, zoom: number) => void;
type ResetZoomHandler = (key: string) => void;
type DragStartState = {
  clientX: number;
  clientY: number;
  scrollLeft: number;
  scrollTop: number;
};

export type ZoomableImageControls = {
  canZoomIn: boolean;
  canZoomOut: boolean;
  resetZoom: () => void;
  zoom: number;
  zoomIn: () => void;
  zoomOut: () => void;
};

type ZoomableArtifactImageCanvasProps = {
  alt: string;
  canvasTestId?: string;
  children?: (controls: ZoomableImageControls) => ReactNode;
  className?: string;
  contentClassName?: string;
  imageClassName?: string;
  imageRef?: Ref<HTMLImageElement>;
  imageTestId: string;
  onError?: () => void;
  onLoad?: () => void;
  src: string;
  zoomKey?: string;
};

function controlsFromZoomState({
  displayZoom,
  resetDisplayZoom,
  setDisplayZoom,
  zoomKey,
}: {
  displayZoom: number;
  resetDisplayZoom: ResetZoomHandler;
  setDisplayZoom: SetZoomHandler;
  zoomKey: string;
}): ZoomableImageControls {
  const zoom = displayZoom;

  return {
    canZoomIn: zoom < IMAGE_LIGHTBOX_MAX_ZOOM - 0.001,
    canZoomOut: zoom > IMAGE_LIGHTBOX_MIN_ZOOM + 0.001,
    resetZoom: () => {
      resetDisplayZoom(zoomKey);
    },
    zoom,
    zoomIn: () => {
      setDisplayZoom(zoomKey, zoom + IMAGE_ZOOM_STEP);
    },
    zoomOut: () => {
      setDisplayZoom(zoomKey, zoom - IMAGE_ZOOM_STEP);
    },
  };
}

function shouldIgnoreDragStart(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return true;
  }
  return Boolean(
    target.closest("button, a, input, textarea, select, [role='button']"),
  );
}

function calculateImageFitWidth(image: HTMLImageElement) {
  const content = image.parentElement;
  const scrollContainer = content?.parentElement;
  if (!content || !scrollContainer) {
    return image.naturalWidth || null;
  }

  const contentStyle = getComputedStyle(content);
  const paddingLeft = Number.parseFloat(contentStyle.paddingLeft);
  const paddingRight = Number.parseFloat(contentStyle.paddingRight);
  const horizontalPadding =
    (Number.isFinite(paddingLeft) ? paddingLeft : 0) +
    (Number.isFinite(paddingRight) ? paddingRight : 0);
  const availableWidth = scrollContainer.clientWidth - horizontalPadding;
  const naturalWidth = image.naturalWidth;

  if (naturalWidth > 0 && availableWidth > 0) {
    return Math.min(naturalWidth, availableWidth);
  }

  if (availableWidth > 0) {
    return availableWidth;
  }

  return naturalWidth > 0 ? naturalWidth : null;
}

export function ZoomableArtifactImageCanvas({
  alt,
  canvasTestId = "zoomable-image-canvas",
  children,
  className,
  contentClassName,
  imageClassName,
  imageRef,
  imageTestId,
  onError,
  onLoad,
  src,
  zoomKey = src,
}: ZoomableArtifactImageCanvasProps) {
  const zoomByKey = useGet(zoomableImageCanvasZoomByKey$);
  const fitWidthByKey = useGet(zoomableImageCanvasFitWidthByKey$);
  const setDisplayZoom = useSet(setZoomableImageCanvasZoom$);
  const setFitWidth = useSet(setZoomableImageCanvasFitWidth$);
  const resetDisplayZoom = useSet(resetZoomableImageCanvasZoom$);
  const setZoomableImageCanvasWheelRef = useSet(zoomableImageCanvasWheelRef$);
  const displayZoom = zoomByKey[zoomKey] ?? 1;
  const fitWidth = fitWidthByKey[zoomKey];
  const imageWidth =
    fitWidth !== undefined
      ? `${Math.round(fitWidth * displayZoom)}px`
      : `${displayZoom * 100}%`;
  const controls = controlsFromZoomState({
    displayZoom,
    resetDisplayZoom,
    setDisplayZoom,
    zoomKey,
  });

  const handleMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || shouldIgnoreDragStart(event.target)) {
      return;
    }

    const scrollContainer = event.currentTarget;
    event.preventDefault();
    const dragStart: DragStartState = {
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: scrollContainer.scrollLeft,
      scrollTop: scrollContainer.scrollTop,
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      scrollContainer.scrollLeft =
        dragStart.scrollLeft - (moveEvent.clientX - dragStart.clientX);
      scrollContainer.scrollTop =
        dragStart.scrollTop - (moveEvent.clientY - dragStart.clientY);
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const handleImageLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const fitWidthValue = calculateImageFitWidth(event.currentTarget);
    if (fitWidthValue !== null) {
      setFitWidth(zoomKey, fitWidthValue);
    }
    resetDisplayZoom(zoomKey);
    onLoad?.();
  };

  return (
    <div
      className={cn(
        "relative h-full min-h-0 w-full flex-1 overflow-hidden bg-muted/30",
        className,
      )}
    >
      {children?.(controls)}
      <div
        ref={setZoomableImageCanvasWheelRef}
        className={cn(
          "h-full min-h-0 w-full overflow-auto overscroll-contain",
          "cursor-grab active:cursor-grabbing",
        )}
        data-testid={canvasTestId}
        data-zoom-key={zoomKey}
        onMouseDown={handleMouseDown}
      >
        <div
          className={cn(
            "flex min-h-full min-w-full items-start justify-center",
            contentClassName,
          )}
          data-testid={`${canvasTestId}-content`}
        >
          <img
            ref={imageRef}
            src={src}
            alt={alt}
            data-testid={imageTestId}
            onLoad={handleImageLoad}
            onError={onError}
            draggable={false}
            style={{
              WebkitTouchCallout: "default",
              pointerEvents: "auto",
              userSelect: "none",
              width: imageWidth,
            }}
            className={cn(
              "block h-auto max-w-none shrink-0 select-none object-contain",
              imageClassName,
            )}
          />
        </div>
      </div>
    </div>
  );
}
