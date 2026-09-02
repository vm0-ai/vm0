import type {
  ReactNode,
  Ref,
  SyntheticEvent,
  WheelEvent as ReactWheelEvent,
} from "react";
import { useGet, useSet } from "ccstate-react";
import {
  type ReactZoomPanPinchContext,
  TransformComponent,
  TransformWrapper,
} from "react-zoom-pan-pinch";
import { cn } from "@okouai/ui";
import {
  IMAGE_LIGHTBOX_MAX_ZOOM,
  IMAGE_LIGHTBOX_MIN_ZOOM,
  type ZoomableImageCanvasGeometry,
  type ZoomableImageCanvasSignals,
} from "../../signals/zoomable-image-canvas.ts";

const IMAGE_ZOOM_STEP = 0.15;
const IMAGE_DOUBLE_CLICK_ZOOM_STEP = 1;
const IMAGE_TRACKPAD_ZOOM_SENSITIVITY = 0.03;
const IMAGE_TRACKPAD_ZOOM_MAX_DELTA = 10;
const IMAGE_WHEEL_LINE_HEIGHT = 16;
const IMAGE_MAX_WIDTH_VIEWPORT_RATIO = 3;

function isImageWheelZoomActivated(keys: string[]): boolean {
  return keys.includes("Control") || keys.includes("Meta");
}

function normalizedImageWheelDelta(
  event: ReactWheelEvent<HTMLDivElement>,
): number {
  let delta = event.deltaY;
  if (event.deltaMode === 1) {
    delta *= IMAGE_WHEEL_LINE_HEIGHT;
  } else if (event.deltaMode === 2) {
    delta *= event.currentTarget.clientHeight;
  }

  return Math.max(
    -IMAGE_TRACKPAD_ZOOM_MAX_DELTA,
    Math.min(IMAGE_TRACKPAD_ZOOM_MAX_DELTA, delta),
  );
}

function proportionalImageWheelStep(
  event: ReactWheelEvent<HTMLDivElement>,
  scale: number,
): number {
  if (event.deltaY === 0) {
    return 0;
  }

  const normalizedDelta = normalizedImageWheelDelta(event);
  const targetScale =
    scale * Math.exp(-normalizedDelta * IMAGE_TRACKPAD_ZOOM_SENSITIVITY);
  return Math.abs(targetScale - scale);
}

function proportionalImageWheelHandler(instance: ReactZoomPanPinchContext) {
  return (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }

    // Convert the exponential target into the linear step expected by the library.
    instance.setup.wheel.step = proportionalImageWheelStep(
      event,
      instance.state.scale,
    );
  };
}

type SetZoomHandler = (zoom: number) => void;

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
  /**
   * Drawn over the image *inside* the zoom transform, so an overlay stays
   * registered with the pixels it describes at every zoom level.
   */
  overlay?: ReactNode;
  canvasTestId?: string;
  children?: (controls: ZoomableImageControls) => ReactNode;
  className?: string;
  contentClassName?: string;
  imageClassName?: string;
  imageRef?: Ref<HTMLImageElement>;
  imageTestId: string;
  onError?: () => void;
  onLoad?: () => void;
  signals: ZoomableImageCanvasSignals;
  src: string;
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
  maxZoom,
  setDisplayZoom,
  resetTransform,
  zoomIn,
  zoomOut,
}: {
  displayZoom: number;
  maxZoom: number;
  setDisplayZoom: SetZoomHandler;
  resetTransform: (animationTime?: number) => void;
  zoomIn: (step?: number, animationTime?: number) => void;
  zoomOut: (step?: number, animationTime?: number) => void;
}): ZoomableImageControls {
  const zoom = displayZoom;

  return {
    canZoomIn: zoom < maxZoom,
    canZoomOut: zoom > IMAGE_LIGHTBOX_MIN_ZOOM,
    resetZoom: () => {
      resetTransform(0);
      setDisplayZoom(1);
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

function imageCanvasGeometry(
  fitWidth: number,
  naturalWidth: number,
  availableWidth: number,
): ZoomableImageCanvasGeometry {
  const maxRenderedWidth = Math.max(
    fitWidth * IMAGE_LIGHTBOX_MAX_ZOOM,
    naturalWidth,
    availableWidth * IMAGE_MAX_WIDTH_VIEWPORT_RATIO,
  );
  return {
    fitWidth,
    maxZoom: maxRenderedWidth / fitWidth,
  };
}

function calculateImageCanvasGeometry(
  image: HTMLImageElement,
): ZoomableImageCanvasGeometry | null {
  const content = image.parentElement;
  const scrollContainer = image.closest<HTMLElement>(
    "[data-zoomable-image-canvas='true']",
  );
  if (!content || !scrollContainer) {
    return image.naturalWidth > 0
      ? imageCanvasGeometry(image.naturalWidth, image.naturalWidth, 0)
      : null;
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
    return imageCanvasGeometry(
      naturalWidth * Math.min(1, widthScale, heightScale),
      naturalWidth,
      availableWidth,
    );
  }

  if (naturalWidth > 0 && availableWidth > 0) {
    return imageCanvasGeometry(
      Math.min(naturalWidth, availableWidth),
      naturalWidth,
      availableWidth,
    );
  }

  if (availableWidth > 0) {
    return imageCanvasGeometry(availableWidth, naturalWidth, availableWidth);
  }

  return naturalWidth > 0
    ? imageCanvasGeometry(naturalWidth, naturalWidth, 0)
    : null;
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

function ZoomableArtifactImageFrame({
  element,
  overlay,
}: {
  element: ZoomableArtifactImageElementProps;
  overlay?: ReactNode;
}) {
  return (
    <div className="relative shrink-0">
      <ZoomableArtifactImageElement {...element} />
      {overlay}
    </div>
  );
}

function ZoomableArtifactImageViewport({
  canvasTestId,
  contentClassName,
  element,
  instance,
  overlay,
}: {
  canvasTestId: string;
  contentClassName?: string;
  element: ZoomableArtifactImageElementProps;
  instance: ReactZoomPanPinchContext;
  overlay?: ReactNode;
}) {
  return (
    <div
      className="h-full min-h-0 w-full cursor-grab overscroll-contain active:cursor-grabbing"
      data-testid={canvasTestId}
      data-zoomable-image-canvas="true"
      style={{ touchAction: "none" }}
    >
      <TransformComponent
        contentStyle={{ height: "100%", width: "100%" }}
        wrapperClass="h-full min-h-0 w-full"
        wrapperProps={{
          onWheelCapture: proportionalImageWheelHandler(instance),
        }}
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
          <ZoomableArtifactImageFrame element={element} overlay={overlay} />
        </div>
      </TransformComponent>
    </div>
  );
}

export function ZoomableArtifactImageCanvas({
  alt,
  canvasTestId = "zoomable-image-canvas",
  children,
  overlay,
  className,
  contentClassName,
  imageClassName,
  imageRef,
  imageTestId,
  onError,
  onLoad,
  signals,
  src,
}: ZoomableArtifactImageCanvasProps) {
  const displayZoom = useGet(signals.zoom$);
  const imageGeometry = useGet(signals.geometry$);
  const setDisplayZoom = useSet(signals.setZoom$);
  const imageLoaded = useSet(signals.loaded$);
  const fitWidth = imageGeometry?.fitWidth;
  const maxZoom = imageGeometry?.maxZoom ?? IMAGE_LIGHTBOX_MAX_ZOOM;
  const imageWidth =
    fitWidth !== undefined ? `${Math.round(fitWidth)}px` : "100%";
  const handleImageLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const geometry = calculateImageCanvasGeometry(event.currentTarget);
    imageLoaded(geometry);
    onLoad?.();
  };

  return (
    <TransformWrapper
      centerZoomedOut
      disablePadding
      doubleClick={{
        mode: displayZoom === 1 ? "zoomIn" : "reset",
        step: IMAGE_DOUBLE_CLICK_ZOOM_STEP,
      }}
      initialScale={1}
      maxScale={maxZoom}
      minScale={IMAGE_LIGHTBOX_MIN_ZOOM}
      autoAlignment={{ disabled: true }}
      onInit={(transformRef) => {
        setDisplayZoom(transformRef.state.scale);
      }}
      onTransform={(_transformRef, transformState) => {
        setDisplayZoom(transformState.scale);
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
        activationKeys: isImageWheelZoomActivated,
        step: 0,
      }}
    >
      {({ instance, resetTransform, zoomIn, zoomOut }) => {
        const controls = controlsFromTransformState({
          displayZoom,
          maxZoom,
          resetTransform,
          setDisplayZoom,
          zoomIn,
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
            <ZoomableArtifactImageViewport
              canvasTestId={canvasTestId}
              contentClassName={contentClassName}
              element={{
                alt,
                imageClassName,
                imageRef,
                imageTestId,
                imageWidth,
                onError,
                onLoad: handleImageLoad,
                src,
              }}
              instance={instance}
              overlay={overlay}
            />
          </div>
        );
      }}
    </TransformWrapper>
  );
}
