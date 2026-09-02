const ZOOMABLE_IMAGE_CANVAS_SELECTOR = "[data-zoomable-image-canvas='true']";

function isZoomableImageCanvasEvent(event: Event): boolean {
  return (
    event.target instanceof Element &&
    event.target.closest(ZOOMABLE_IMAGE_CANVAS_SELECTOR) !== null
  );
}

function preventViewportPinch(event: Event): void {
  if (!isZoomableImageCanvasEvent(event)) {
    event.preventDefault();
  }
}

function preventViewportWheelZoom(event: WheelEvent): void {
  if (event.ctrlKey) {
    preventViewportPinch(event);
  }
}

export function setupViewportPinchPrevention(signal: AbortSignal): void {
  const options: AddEventListenerOptions = {
    capture: true,
    passive: false,
    signal,
  };
  document.addEventListener("wheel", preventViewportWheelZoom, options);
  document.addEventListener("gesturestart", preventViewportPinch, options);
  document.addEventListener("gesturechange", preventViewportPinch, options);
}
