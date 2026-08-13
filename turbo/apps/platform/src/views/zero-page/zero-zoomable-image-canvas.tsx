import type { ReactNode, Ref, SyntheticEvent } from "react";
import { useGet, useSet } from "ccstate-react";
import { TransformComponent, TransformWrapper } from "react-zoom-pan-pinch";
import { cn } from "@okouai/ui";
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
const IMAGE_DOUBLE_CLICK_ZOOM_STEP = 1;

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

type ZoomableArtifactImageElementProps = {
  alt: string;
  imageClassName?: string;
  imageRef?: Ref<HTMLImageElement>;
  imageTestId: string;
  imageWidth: string;
  onError?: () => void;
  onLoad: (event: SyntheticEvent<HTMLImageElement>) => void;
  src: string;
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
    canZoomIn: zoom < IMAGE_LIGHTBOX_MAX_ZOOM,
    canZoomOut: zoom > IMAGE_LIGHTBOX_MIN_ZOOM,
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

function cssPixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function calculateImageFitWidth(image: HTMLImageElement): number | null {
  const content = image.parentElement;
  const scrollContainer = image.closest<HTMLElement>(
    "[data-zoomable-image-canvas='true']",
  );
  if (!content || !scrollContainer) {
    return image.naturalWidth || null;
  }

  const contentStyle = getComputedStyle(content);
  const paddingLeft = cssPixelValue(contentStyle.paddingLeft);
  const paddingRight = cssPixelValue(contentStyle.paddingRight);
  const paddingTop = cssPixelValue(contentStyle.paddingTop);
  const paddingBottom = cssPixelValue(contentStyle.paddingBottom);
  const horizontalPadding = paddingLeft + paddingRight;
  const verticalPadding = paddingTop + paddingBottom;
  const availableWidth = scrollContainer.clientWidth - horizontalPadding;
  const availableHeight = scrollContainer.clientHeight - verticalPadding;
  const naturalWidth = image.naturalWidth;
  const naturalHeight = image.naturalHeight;

  if (naturalWidth > 0 && naturalHeight > 0) {
    const widthScale = availableWidth > 0 ? availableWidth / naturalWidth : 1;
    const heightScale =
      availableHeight > 0 ? availableHeight / naturalHeight : 1;
    return naturalWidth * Math.min(1, widthScale, heightScale);
  }

  if (naturalWidth > 0 && availableWidth > 0) {
    return Math.min(naturalWidth, availableWidth);
  }

  if (availableWidth > 0) {
    return availableWidth;
  }

  return naturalWidth > 0 ? naturalWidth : null;
}

function ZoomableArtifactImageElement({
  alt,
  imageClassName,
  imageRef,
  imageTestId,
  imageWidth,
  onError,
  onLoad,
  src,
}: ZoomableArtifactImageElementProps) {
  return (
    <img
      ref={imageRef}
      src={src}
      alt={alt}
      data-testid={imageTestId}
      loading="eager"
      decoding="async"
      fetchPriority="high"
      onLoad={onLoad}
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
  );
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
      disablePadding
      doubleClick={{
        mode: displayZoom === 1 ? "zoomIn" : "reset",
        step: IMAGE_DOUBLE_CLICK_ZOOM_STEP,
      }}
      initialScale={1}
      maxScale={IMAGE_LIGHTBOX_MAX_ZOOM}
      minScale={IMAGE_LIGHTBOX_MIN_ZOOM}
      autoAlignment={{ disabled: true }}
      onInit={(transformRef) => {
        setDisplayZoom(zoomKey, transformRef.state.scale);
      }}
      onTransform={(_transformRef, transformState) => {
        setDisplayZoom(zoomKey, transformState.scale);
      }}
      panning={{
        allowMiddleClickPan: false,
        allowRightClickPan: false,
        velocityDisabled: true,
      }}
      pinch={{ allowPanning: false }}
      smooth={false}
      trackPadPanning={{ disabled: false }}
      wheel={{
        activationKeys: ["Control"],
        wheelDisabled: true,
      }}
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
                contentStyle={{ height: "100%", width: "100%" }}
                wrapperClass="h-full min-h-0 w-full"
                wrapperStyle={{
                  height: "100%",
                  touchAction: "none",
                  width: "100%",
                }}
              >
                <div
                  className={cn(
                    "flex h-full w-full items-center justify-center",
                    contentClassName,
                  )}
                  data-testid={`${canvasTestId}-content`}
                >
                  <ZoomableArtifactImageElement
                    alt={alt}
                    imageClassName={imageClassName}
                    imageRef={imageRef}
                    imageTestId={imageTestId}
                    imageWidth={imageWidth}
                    onError={onError}
                    onLoad={handleImageLoad}
                    src={src}
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
