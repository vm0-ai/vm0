import type { ReactNode, Ref, RefCallback } from "react";
import { useGet, useSet } from "ccstate-react";
import {
  TransformComponent,
  TransformWrapper,
  type ReactZoomPanPinchContentRef,
  type ReactZoomPanPinchRef,
} from "react-zoom-pan-pinch";
import { cn } from "@vm0/ui";
import {
  IMAGE_LIGHTBOX_MAX_ZOOM,
  IMAGE_LIGHTBOX_MIN_ZOOM,
  resetZoomableImageCanvasZoom$,
  setZoomableImageCanvasZoom$,
  zoomableImageCanvasZoomByKey$,
} from "../../signals/view-component-state.ts";

const IMAGE_ZOOM_STEP = 0.15;
const IMAGE_ZOOM_ANIMATION_MS = 180;
const IMAGE_ZOOM_ANIMATION_TYPE = "linear";

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
  keyboardShortcuts?: boolean;
  onError?: () => void;
  onLoad?: () => void;
  src: string;
  zoomKey?: string;
};

function keyboardShortcutRef({
  resetZoom,
  zoomIn,
  zoomOut,
}: Pick<
  ZoomableImageControls,
  "resetZoom" | "zoomIn" | "zoomOut"
>): RefCallback<HTMLSpanElement> {
  let detachKeydown: (() => void) | null = null;

  return (element) => {
    detachKeydown?.();
    detachKeydown = null;

    if (!element) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) {
        return;
      }

      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        event.stopPropagation();
        zoomIn();
        return;
      }

      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        event.stopPropagation();
        zoomOut();
        return;
      }

      if (event.key === "0") {
        event.preventDefault();
        event.stopPropagation();
        resetZoom();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    detachKeydown = () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  };
}

function ZoomableImageKeyboardShortcuts({
  controls,
  enabled,
}: {
  controls: ZoomableImageControls;
  enabled: boolean;
}) {
  if (!enabled) {
    return null;
  }

  return <span ref={keyboardShortcutRef(controls)} hidden />;
}

function controlsFromTransform({
  displayZoom,
  resetDisplayZoom,
  resetTransform,
  setDisplayZoom,
  zoomIn,
  zoomKey,
  zoomOut,
}: Pick<
  ReactZoomPanPinchContentRef,
  "resetTransform" | "zoomIn" | "zoomOut"
> & {
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
      resetTransform(IMAGE_ZOOM_ANIMATION_MS, IMAGE_ZOOM_ANIMATION_TYPE);
    },
    zoom,
    zoomIn: () => {
      setDisplayZoom(zoomKey, zoom + IMAGE_ZOOM_STEP);
      zoomIn(
        IMAGE_ZOOM_STEP,
        IMAGE_ZOOM_ANIMATION_MS,
        IMAGE_ZOOM_ANIMATION_TYPE,
      );
    },
    zoomOut: () => {
      setDisplayZoom(zoomKey, zoom - IMAGE_ZOOM_STEP);
      zoomOut(
        IMAGE_ZOOM_STEP,
        IMAGE_ZOOM_ANIMATION_MS,
        IMAGE_ZOOM_ANIMATION_TYPE,
      );
    },
  };
}

function hasMeasurableCanvas(ref: ReactZoomPanPinchRef) {
  const { contentComponent, wrapperComponent } = ref.instance;

  return Boolean(
    wrapperComponent?.offsetWidth ||
    wrapperComponent?.offsetHeight ||
    contentComponent?.offsetWidth ||
    contentComponent?.offsetHeight,
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
  keyboardShortcuts = false,
  onError,
  onLoad,
  src,
  zoomKey = src,
}: ZoomableArtifactImageCanvasProps) {
  const zoomByKey = useGet(zoomableImageCanvasZoomByKey$);
  const setDisplayZoom = useSet(setZoomableImageCanvasZoom$);
  const resetDisplayZoom = useSet(resetZoomableImageCanvasZoom$);
  const displayZoom = zoomByKey[zoomKey] ?? 1;

  const syncDisplayZoom = (ref: ReactZoomPanPinchRef) => {
    if (!hasMeasurableCanvas(ref)) {
      return;
    }

    setDisplayZoom(zoomKey, ref.state.scale);
  };

  return (
    <TransformWrapper
      key={zoomKey}
      initialScale={1}
      minScale={IMAGE_LIGHTBOX_MIN_ZOOM}
      maxScale={IMAGE_LIGHTBOX_MAX_ZOOM}
      limitToBounds
      centerZoomedOut
      smooth
      wheel={{ step: 0.008, wheelDisabled: true }}
      trackPadPanning={{ disabled: false }}
      panning={{ allowLeftClickPan: true }}
      pinch={{ allowPanning: false, step: 5 }}
      doubleClick={{
        mode: "toggle",
        step: IMAGE_ZOOM_STEP,
        animationTime: IMAGE_ZOOM_ANIMATION_MS,
        animationType: IMAGE_ZOOM_ANIMATION_TYPE,
      }}
      zoomAnimation={{
        animationTime: IMAGE_ZOOM_ANIMATION_MS,
        animationType: IMAGE_ZOOM_ANIMATION_TYPE,
        size: 0.2,
      }}
      onPinchStop={(ref) => {
        syncDisplayZoom(ref);
      }}
      onWheelStop={(ref) => {
        syncDisplayZoom(ref);
      }}
      onZoomStop={(ref) => {
        syncDisplayZoom(ref);
      }}
      onInit={() => {
        resetDisplayZoom(zoomKey);
      }}
    >
      {(transform) => {
        const controls = controlsFromTransform({
          ...transform,
          displayZoom,
          resetDisplayZoom,
          setDisplayZoom,
          zoomKey,
        });

        return (
          <div
            className={cn(
              "relative flex h-full min-h-0 w-full flex-1 items-center justify-center overflow-hidden bg-muted/30 touch-none",
              className,
            )}
            data-testid={canvasTestId}
          >
            <ZoomableImageKeyboardShortcuts
              controls={controls}
              enabled={keyboardShortcuts}
            />
            {children?.(controls)}
            <TransformComponent
              contentClass={contentClassName}
              wrapperStyle={{ height: "100%", width: "100%" }}
              contentStyle={{
                alignItems: "center",
                boxSizing: "border-box",
                display: "flex",
                height: "100%",
                justifyContent: "center",
                width: "100%",
              }}
            >
              <img
                ref={imageRef}
                src={src}
                alt={alt}
                draggable={false}
                data-testid={imageTestId}
                onLoad={onLoad}
                onError={onError}
                className={cn(
                  "block max-h-full max-w-full select-none object-contain",
                  imageClassName,
                )}
              />
            </TransformComponent>
          </div>
        );
      }}
    </TransformWrapper>
  );
}
