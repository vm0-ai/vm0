import { command, type Command } from "ccstate";
import { onRef } from "../utils.ts";

interface PresentationSlideListDependencies {
  readonly loadThumbnail: (frame: HTMLIFrameElement, slideId: string) => void;
  readonly releaseThumbnail: (frame: HTMLIFrameElement) => void;
}

export interface PresentationSlideListSignals {
  readonly setRootRef$: Command<(() => void) | undefined, [HTMLElement | null]>;
}

export function createPresentationSlideListSignals(
  dependencies: PresentationSlideListDependencies,
): PresentationSlideListSignals {
  const setRootRef$ = onRef(
    command((_ctx, root: HTMLElement, signal: AbortSignal) => {
      const frames = Array.from(
        root.querySelectorAll<HTMLIFrameElement>(
          "[data-slide-thumbnail-frame]",
        ),
      );
      const observer =
        typeof IntersectionObserver === "undefined"
          ? null
          : new IntersectionObserver(
              (entries, currentObserver) => {
                if (signal.aborted) {
                  return;
                }
                for (const entry of entries) {
                  if (
                    !entry.isIntersecting ||
                    !(entry.target instanceof HTMLIFrameElement)
                  ) {
                    continue;
                  }
                  const slideId = entry.target.dataset.slideThumbnailFrame;
                  if (slideId) {
                    dependencies.loadThumbnail(entry.target, slideId);
                  }
                  currentObserver.unobserve(entry.target);
                }
              },
              { root, rootMargin: "480px" },
            );

      for (const frame of frames) {
        const slideId = frame.dataset.slideThumbnailFrame;
        if (!slideId) {
          continue;
        }
        if (!observer || frame.dataset.slideThumbnailActive === "true") {
          dependencies.loadThumbnail(frame, slideId);
        } else {
          observer.observe(frame);
        }
      }

      signal.addEventListener(
        "abort",
        () => {
          observer?.disconnect();
          for (const frame of frames) {
            dependencies.releaseThumbnail(frame);
          }
        },
        { once: true },
      );
    }),
  );

  return { setRootRef$ };
}
