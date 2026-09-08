const ZOOMABLE_IMAGE_CANVAS_SELECTOR = "[data-zoomable-image-canvas='true']";
const VIEWPORT_ZOOM_ATTRIBUTE = "data-allow-viewport-zoom";

function isZoomableImageCanvasEvent(event: Event): boolean {
  return (
    event.target instanceof Element &&
    event.target.closest(ZOOMABLE_IMAGE_CANVAS_SELECTOR) !== null
  );
}

function preventViewportPinch(event: Event): void {
  if (
    !document.documentElement.hasAttribute(VIEWPORT_ZOOM_ATTRIBUTE) &&
    !isZoomableImageCanvasEvent(event)
  ) {
    event.preventDefault();
  }
}

// Route-owned accessibility opt-in. Keep the app's existing viewport and
// gesture policy everywhere else, including when leaving a hosted auth step.
export function enableViewportZoom(signal: AbortSignal): void {
  signal.throwIfAborted();
  const root = document.documentElement;
  const previousZoomAttribute = root.getAttribute(VIEWPORT_ZOOM_ATTRIBUTE);
  const viewport = document.querySelector<HTMLMetaElement>(
    'meta[name="viewport"]',
  );
  const previousContent = viewport?.getAttribute("content") ?? null;

  root.setAttribute(VIEWPORT_ZOOM_ATTRIBUTE, "");
  if (viewport && previousContent !== null) {
    viewport.content = previousContent
      .split(",")
      .filter((directive) => {
        return !/^(maximum-scale|user-scalable)\s*=/iu.test(directive.trim());
      })
      .join(",");
  }

  signal.addEventListener(
    "abort",
    () => {
      if (previousZoomAttribute === null) {
        root.removeAttribute(VIEWPORT_ZOOM_ATTRIBUTE);
      } else {
        root.setAttribute(VIEWPORT_ZOOM_ATTRIBUTE, previousZoomAttribute);
      }
      if (viewport && previousContent !== null) {
        viewport.setAttribute("content", previousContent);
      }
    },
    { once: true },
  );
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
