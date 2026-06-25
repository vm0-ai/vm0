import type { ReactNode, Ref, SyntheticEvent } from "react";
import { useGet, useSet } from "ccstate-react";
import { TransformComponent, TransformWrapper } from "react-zoom-pan-pinch";
import { cn } from "@vm0/ui";
import {
  IMAGE_LIGHTBOX_MAX_ZOOM,
  IMAGE_LIGHTBOX_MIN_ZOOM,
  resetZoomableImageCanvasZoom$,
  setZoomableImageCanvasFitWidth$,
  setZoomableImageCanvasZoom$,
  zoomableImageCanvasFitWidthByKey$,
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

function controlsFromTransformState({
  displayZoom,
  setDisplayZoom,
  resetTransform,
  zoomIn,
  zoomOut,
  zoomKey,
}: {
  displayZoom: number;
  setDisplayZoom: SetZoomHandler;
  resetTransform: (animationTime?: number) => void;
  zoomIn: (step?: number, animationTime?: number) => void;
  zoomOut: (step?: number, animationTime?: number) => void;
  zoomKey: string;
}): ZoomableImageControls {
  const zoom = displayZoom;

  return {
    canZoomIn: zoom < IMAGE_LIGHTBOX_MAX_ZOOM - 0.001,
    canZoomOut: zoom > IMAGE_LIGHTBOX_MIN_ZOOM + 0.001,
    resetZoom: () => {
      resetTransform(0);
      setDisplayZoom(zoomKey, 1);
    },
    zoom,
    zoomIn: () => {
      zoomIn(IMAGE_ZOOM_STEP, 0);
    },
    zoomOut: () => {
      zoomOut(IMAGE_ZOOM_STEP, 0);
    },
  };
}

function calculateImageFitWidth(image: HTMLImageElement) {
  const content = image.parentElement;
  const scrollContainer = image.closest<HTMLElement>(
    "[data-zoomable-image-canvas='true']",
  );
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
  const displayZoom = zoomByKey[zoomKey] ?? 1;
  const fitWidth = fitWidthByKey[zoomKey];
  const imageWidth =
    fitWidth !== undefined ? `${Math.round(fitWidth)}px` : "100%";
  const handleImageLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const fitWidthValue = calculateImageFitWidth(event.currentTarget);
    if (fitWidthValue !== null) {
      setFitWidth(zoomKey, fitWidthValue);
    }
    resetDisplayZoom(zoomKey);
    onLoad?.();
  };

  return (
    <TransformWrapper
      key={zoomKey}
      centerZoomedOut
      doubleClick={{ disabled: true }}
      initialScale={1}
      maxScale={IMAGE_LIGHTBOX_MAX_ZOOM}
      minScale={IMAGE_LIGHTBOX_MIN_ZOOM}
      onInit={(transformRef) => {
        setDisplayZoom(zoomKey, transformRef.state.scale);
      }}
      onTransform={(_transformRef, transformState) => {
        setDisplayZoom(zoomKey, transformState.scale);
      }}
      panning={{ velocityDisabled: true }}
      smooth={false}
      wheel={{ activationKeys: ["Control"] }}
    >
      {({ resetTransform, zoomIn, zoomOut }) => {
        const controls = controlsFromTransformState({
          displayZoom,
          resetTransform,
          setDisplayZoom,
          zoomIn,
          zoomKey,
          zoomOut,
        });

        return (
          <div
            className={cn(
              "relative h-full min-h-0 w-full flex-1 overflow-hidden bg-muted/30",
              className,
            )}
          >
            {children?.(controls)}
            <div
              className="h-full min-h-0 w-full cursor-grab overscroll-contain active:cursor-grabbing"
              data-testid={canvasTestId}
              data-zoomable-image-canvas="true"
              style={{ touchAction: "none" }}
            >
              <TransformComponent
                contentClass="min-h-full min-w-full"
                wrapperClass="h-full min-h-0 w-full"
                wrapperStyle={{
                  height: "100%",
                  touchAction: "none",
                  width: "100%",
                }}
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
              </TransformComponent>
            </div>
          </div>
        );
      }}
    </TransformWrapper>
  );
}
