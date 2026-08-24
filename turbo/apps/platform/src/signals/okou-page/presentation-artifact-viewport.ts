import { command } from "ccstate";
import { onRef } from "../utils.ts";

export const PRESENTATION_ARTIFACT_VIEWPORT_WIDTH = 1920;
export const PRESENTATION_ARTIFACT_VIEWPORT_HEIGHT = 1080;

function presentationArtifactCanvas(container: HTMLDivElement): HTMLDivElement {
  const canvas = container.querySelector<HTMLDivElement>(
    "[data-presentation-artifact-canvas]",
  );
  if (!canvas) {
    throw new Error("Presentation artifact viewport has no canvas");
  }
  return canvas;
}

function fitPresentationArtifactCanvas(
  container: HTMLDivElement,
  canvas: HTMLDivElement,
): void {
  const { clientHeight, clientWidth } = container;
  if (clientHeight === 0 || clientWidth === 0) {
    canvas.style.visibility = "hidden";
    return;
  }

  const scale = Math.min(
    clientWidth / PRESENTATION_ARTIFACT_VIEWPORT_WIDTH,
    clientHeight / PRESENTATION_ARTIFACT_VIEWPORT_HEIGHT,
  );
  const left = (clientWidth - PRESENTATION_ARTIFACT_VIEWPORT_WIDTH * scale) / 2;
  const top =
    (clientHeight - PRESENTATION_ARTIFACT_VIEWPORT_HEIGHT * scale) / 2;

  canvas.style.transform = `translate(${String(left)}px, ${String(top)}px) scale(${String(scale)})`;
  canvas.style.visibility = "visible";
}

const attachPresentationArtifactViewport$ = command(
  (_, container: HTMLDivElement, signal: AbortSignal): void => {
    const canvas = presentationArtifactCanvas(container);
    const fit = () => {
      fitPresentationArtifactCanvas(container, canvas);
    };
    const observer = new ResizeObserver(fit);

    observer.observe(container);
    signal.addEventListener(
      "abort",
      () => {
        observer.disconnect();
      },
      { once: true },
    );
    fit();
  },
);

export const presentationArtifactViewportRef$ = onRef(
  attachPresentationArtifactViewport$,
);
