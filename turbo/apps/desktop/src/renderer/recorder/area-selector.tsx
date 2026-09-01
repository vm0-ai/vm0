import { useCallback, useEffect, useState } from "react";
import { areaFromDrag } from "../../desktop-recorder-overlay-geometry";
import type { DesktopRecorderArea } from "../../desktop-recorder-types";

interface DragPoint {
  readonly x: number;
  readonly y: number;
}

const recorder = window.vm0DesktopRecorder;

/**
 * Full-screen overlay for dragging out the region to record.
 *
 * The window covers one display and is dismissed the moment a region is drawn,
 * so it is never part of a capture.
 */
export function AreaSelector(): React.ReactElement {
  const [start, setStart] = useState<DragPoint | null>(null);
  const [current, setCurrent] = useState<DragPoint | null>(null);

  const cancel = useCallback(() => {
    void recorder?.completeAreaSelection(null);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        cancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [cancel]);

  const selection: DesktopRecorderArea | null =
    start && current ? areaFromDrag(start, current) : null;

  return (
    <div
      className="area-selector"
      role="presentation"
      onMouseDown={(event) => {
        const point = { x: event.clientX, y: event.clientY };
        setStart(point);
        setCurrent(point);
      }}
      onMouseMove={(event) => {
        if (start) {
          setCurrent({ x: event.clientX, y: event.clientY });
        }
      }}
      onMouseUp={() => {
        // A click without a drag is a miss, not a zero-sized region.
        if (!selection || selection.width < 2 || selection.height < 2) {
          cancel();
          return;
        }
        void recorder?.completeAreaSelection(selection);
      }}
    >
      {selection ? (
        <div
          className="area-selector__region"
          style={{
            left: `${selection.x.toString()}px`,
            top: `${selection.y.toString()}px`,
            width: `${selection.width.toString()}px`,
            height: `${selection.height.toString()}px`,
          }}
        >
          <span className="area-selector__size">
            {selection.width} × {selection.height}
          </span>
        </div>
      ) : (
        <p className="area-selector__hint">
          Drag to choose what to record · Esc to cancel
        </p>
      )}
    </div>
  );
}
