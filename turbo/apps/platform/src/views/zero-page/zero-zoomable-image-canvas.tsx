import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
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
type TouchPoint = {
  clientX: number;
  clientY: number;
  pointerId: number;
};
type TouchGestureState =
  | {
      clientX: number;
      clientY: number;
      kind: "pan";
      pointerId: number;
      scrollLeft: number;
      scrollTop: number;
    }
  | {
      contentX: number;
      contentY: number;
      distance: number;
      kind: "pinch";
      zoom: number;
    };
type TouchSurfaceState = {
  gesture: TouchGestureState | null;
  pointers: Map<number, TouchPoint>;
};
type TouchSurfaceElement = HTMLDivElement & {
  __vm0ZoomableImageTouchState?: TouchSurfaceState;
};
type ZoomableTouchGestureContext = {
  displayZoom: number;
  setDisplayZoom: SetZoomHandler;
  surfaceState: TouchSurfaceState;
  zoomKey: string;
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

function clampDisplayZoom(zoom: number) {
  return Math.min(
    IMAGE_LIGHTBOX_MAX_ZOOM,
    Math.max(IMAGE_LIGHTBOX_MIN_ZOOM, zoom),
  );
}

function touchDistance(a: TouchPoint, b: TouchPoint) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function touchMidpoint(a: TouchPoint, b: TouchPoint) {
  return {
    clientX: (a.clientX + b.clientX) / 2,
    clientY: (a.clientY + b.clientY) / 2,
  };
}

function firstTwoTouchPoints(
  touchPointers: Map<number, TouchPoint>,
): [TouchPoint, TouchPoint] | null {
  const points = Array.from(touchPointers.values());
  const [first, second] = points;
  return first && second ? [first, second] : null;
}

function touchSurfaceStateFor(
  scrollContainer: HTMLDivElement,
): TouchSurfaceState {
  const touchSurface = scrollContainer as TouchSurfaceElement;

  touchSurface.__vm0ZoomableImageTouchState ??= {
    gesture: null,
    pointers: new Map<number, TouchPoint>(),
  };
  return touchSurface.__vm0ZoomableImageTouchState;
}

function startMouseDragPan(event: ReactMouseEvent<HTMLDivElement>) {
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
}

function startTouchPanGesture(
  context: ZoomableTouchGestureContext,
  scrollContainer: HTMLDivElement,
  pointer: TouchPoint,
) {
  context.surfaceState.gesture = {
    clientX: pointer.clientX,
    clientY: pointer.clientY,
    kind: "pan",
    pointerId: pointer.pointerId,
    scrollLeft: scrollContainer.scrollLeft,
    scrollTop: scrollContainer.scrollTop,
  };
}

function startTouchPinchGesture(
  context: ZoomableTouchGestureContext,
  scrollContainer: HTMLDivElement,
) {
  const points = firstTwoTouchPoints(context.surfaceState.pointers);
  if (!points) {
    return;
  }

  const [first, second] = points;
  const distance = touchDistance(first, second);
  if (distance <= 0) {
    return;
  }

  const midpoint = touchMidpoint(first, second);
  const rect = scrollContainer.getBoundingClientRect();
  const viewportX = midpoint.clientX - rect.x;
  const viewportY = midpoint.clientY - rect.y;

  context.surfaceState.gesture = {
    contentX: scrollContainer.scrollLeft + viewportX,
    contentY: scrollContainer.scrollTop + viewportY,
    distance,
    kind: "pinch",
    zoom: context.displayZoom,
  };
}

function applyTouchPanGesture(
  gesture: Extract<TouchGestureState, { kind: "pan" }>,
  context: ZoomableTouchGestureContext,
  scrollContainer: HTMLDivElement,
) {
  const pointer = context.surfaceState.pointers.get(gesture.pointerId);
  if (!pointer) {
    return;
  }

  scrollContainer.scrollLeft =
    gesture.scrollLeft - (pointer.clientX - gesture.clientX);
  scrollContainer.scrollTop =
    gesture.scrollTop - (pointer.clientY - gesture.clientY);
}

function applyTouchPinchGesture(
  gesture: Extract<TouchGestureState, { kind: "pinch" }>,
  context: ZoomableTouchGestureContext,
  scrollContainer: HTMLDivElement,
) {
  const points = firstTwoTouchPoints(context.surfaceState.pointers);
  if (!points) {
    return;
  }

  const [first, second] = points;
  const nextDistance = touchDistance(first, second);
  if (nextDistance <= 0) {
    return;
  }

  const nextZoom = clampDisplayZoom(
    gesture.zoom * (nextDistance / gesture.distance),
  );
  const zoomRatio = nextZoom / gesture.zoom;
  const midpoint = touchMidpoint(first, second);
  const rect = scrollContainer.getBoundingClientRect();
  const viewportX = midpoint.clientX - rect.x;
  const viewportY = midpoint.clientY - rect.y;

  context.setDisplayZoom(context.zoomKey, nextZoom);
  scrollContainer.scrollLeft = gesture.contentX * zoomRatio - viewportX;
  scrollContainer.scrollTop = gesture.contentY * zoomRatio - viewportY;
}

function applyTouchGesture(
  context: ZoomableTouchGestureContext,
  scrollContainer: HTMLDivElement,
) {
  const gesture = context.surfaceState.gesture;
  if (!gesture) {
    return;
  }

  if (gesture.kind === "pan") {
    applyTouchPanGesture(gesture, context, scrollContainer);
    return;
  }

  applyTouchPinchGesture(gesture, context, scrollContainer);
}

function refreshTouchGestureAfterPointerRelease(
  context: ZoomableTouchGestureContext,
  scrollContainer: HTMLDivElement,
) {
  if (context.surfaceState.pointers.size >= 2) {
    startTouchPinchGesture(context, scrollContainer);
    return;
  }

  const [remainingPointer] = context.surfaceState.pointers.values();
  if (remainingPointer) {
    startTouchPanGesture(context, scrollContainer, remainingPointer);
    return;
  }

  context.surfaceState.gesture = null;
}

function handleTouchPointerDown(
  event: ReactPointerEvent<HTMLDivElement>,
  context: ZoomableTouchGestureContext,
) {
  if (event.pointerType !== "touch" || shouldIgnoreDragStart(event.target)) {
    return;
  }

  const scrollContainer = event.currentTarget;
  event.preventDefault();
  if (typeof scrollContainer.setPointerCapture === "function") {
    scrollContainer.setPointerCapture(event.pointerId);
  }

  const pointer = {
    clientX: event.clientX,
    clientY: event.clientY,
    pointerId: event.pointerId,
  };
  context.surfaceState.pointers.set(event.pointerId, pointer);

  if (context.surfaceState.pointers.size >= 2) {
    startTouchPinchGesture(context, scrollContainer);
    return;
  }

  startTouchPanGesture(context, scrollContainer, pointer);
}

function handleTouchPointerMove(
  event: ReactPointerEvent<HTMLDivElement>,
  context: ZoomableTouchGestureContext,
) {
  if (
    event.pointerType !== "touch" ||
    !context.surfaceState.pointers.has(event.pointerId)
  ) {
    return;
  }

  event.preventDefault();
  context.surfaceState.pointers.set(event.pointerId, {
    clientX: event.clientX,
    clientY: event.clientY,
    pointerId: event.pointerId,
  });
  applyTouchGesture(context, event.currentTarget);
}

function handleTouchPointerEnd(
  event: ReactPointerEvent<HTMLDivElement>,
  context: ZoomableTouchGestureContext,
) {
  if (
    event.pointerType !== "touch" ||
    !context.surfaceState.pointers.has(event.pointerId)
  ) {
    return;
  }

  event.preventDefault();
  const scrollContainer = event.currentTarget;
  context.surfaceState.pointers.delete(event.pointerId);
  if (typeof scrollContainer.releasePointerCapture === "function") {
    scrollContainer.releasePointerCapture(event.pointerId);
  }
  refreshTouchGestureAfterPointerRelease(context, scrollContainer);
}

function touchGestureContext(
  scrollContainer: HTMLDivElement,
  {
    displayZoom,
    setDisplayZoom,
    zoomKey,
  }: {
    displayZoom: number;
    setDisplayZoom: SetZoomHandler;
    zoomKey: string;
  },
): ZoomableTouchGestureContext {
  return {
    displayZoom,
    setDisplayZoom,
    surfaceState: touchSurfaceStateFor(scrollContainer),
    zoomKey,
  };
}

function zoomableTouchGestureHandlers({
  displayZoom,
  setDisplayZoom,
  zoomKey,
}: {
  displayZoom: number;
  setDisplayZoom: SetZoomHandler;
  zoomKey: string;
}) {
  const args = { displayZoom, setDisplayZoom, zoomKey };

  return {
    onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => {
      handleTouchPointerEnd(
        event,
        touchGestureContext(event.currentTarget, args),
      );
    },
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      handleTouchPointerDown(
        event,
        touchGestureContext(event.currentTarget, args),
      );
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      handleTouchPointerMove(
        event,
        touchGestureContext(event.currentTarget, args),
      );
    },
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => {
      handleTouchPointerEnd(
        event,
        touchGestureContext(event.currentTarget, args),
      );
    },
  };
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
  const touchGestureHandlers = zoomableTouchGestureHandlers({
    displayZoom,
    setDisplayZoom,
    zoomKey,
  });

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
        onMouseDown={startMouseDragPan}
        style={{ touchAction: "none" }}
        {...touchGestureHandlers}
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
