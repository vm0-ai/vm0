import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { TouchSelectionGeometry } from "../../signals/chat-page/chat-touch-selection.ts";

export function ChatTouchSelection({
  geometry,
  threadId,
}: {
  readonly geometry: TouchSelectionGeometry;
  readonly threadId: string | null;
}) {
  const { t } = useTranslation();
  return createPortal(
    <>
      <svg
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-40 h-full w-full overflow-visible"
      >
        {/* One filled path unions overlapping inline and text rectangles. It
            works on supported iOS 16.4 without the newer CSS Highlight API. */}
        <path
          className="okou-chat-touch-highlight"
          d={geometry.rects
            .map((rect) => {
              return `M${rect.left},${rect.top}h${rect.width}v${rect.height}h${-rect.width}Z`;
            })
            .join(" ")}
        />
      </svg>
      {(["start", "end"] as const).map((edge) => {
        const rect = geometry[edge];
        return (
          <button
            key={edge}
            type="button"
            data-chat-selection-interaction
            data-chat-selection-handle={edge}
            data-chat-selection-thread={threadId}
            aria-label={
              edge === "start"
                ? t(($) => {
                    return $.chat.feedback.selectionStart;
                  })
                : t(($) => {
                    return $.chat.feedback.selectionEnd;
                  })
            }
            className="fixed z-50 flex size-11 touch-none select-none items-center justify-center rounded-full text-primary transition-colors hover:bg-gray-50"
            style={{
              left: rect.left - 22,
              top: (edge === "start" ? rect.top : rect.top + rect.height) - 22,
            }}
          >
            <span className="size-3 rounded-full bg-current" />
          </button>
        );
      })}
    </>,
    document.body,
  );
}
