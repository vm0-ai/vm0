import type { PointerEvent as ReactPointerEvent } from "react";
import type {
  ImageAnnotation,
  ImageAnnotationMark,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  HIGHLIGHT_FILL,
  markOrdinal,
  NOTE_GROUND,
  noteOnImage,
  REDACT_FILL,
  STROKE_HALO_INNER,
} from "../../signals/okou-page/image-annotation.ts";

/**
 * One renderer for both surfaces. The read-only viewer and the editor drew the
 * same marks from two implementations before, which is how the viewer ended up
 * showing a clean image while the editor showed the annotations.
 */

export function markInk(mark: ImageAnnotationMark): string {
  if (mark.shape === "highlight" || mark.shape === "redact") {
    return REDACT_FILL;
  }
  return mark.ink;
}

/** Head length as a fraction of the shorter edge. */
const ARROW_HEAD_UNITS = 0.045;

function percent(value: number): string {
  return `${value * 100}%`;
}

function StrokeMark({
  mark,
  aspect,
}: {
  mark: ImageAnnotationMark;
  aspect: number;
}) {
  if (mark.shape === "pen") {
    const points = mark.points
      .map((point) => {
        return `${point.x * 100},${point.y * 100}`;
      })
      .join(" ");
    return (
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 h-full w-full"
      >
        <polyline
          points={points}
          fill="none"
          stroke={STROKE_HALO_INNER}
          vectorEffect="non-scaling-stroke"
          style={{ strokeWidth: 5 }}
        />
        <polyline
          points={points}
          fill="none"
          stroke={mark.ink}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          style={{ strokeWidth: 3 }}
        />
      </svg>
    );
  }

  if (mark.shape !== "arrow") {
    return null;
  }

  // The SVG is stretched to a non-square box, so anything that is not a
  // straight line comes out skewed — which is why the tip used to render as a
  // squashed ellipse instead of a head. The head is therefore built from the
  // angle as it appears *on screen* and converted back into the stretched
  // space, using the box's aspect ratio.
  const dx = (mark.to.x - mark.from.x) * aspect;
  const dy = mark.to.y - mark.from.y;
  const angle = Math.atan2(dy, dx);
  const spread = Math.PI / 7;
  const head = ARROW_HEAD_UNITS;
  const wing = (offset: number) => {
    return {
      x: (mark.to.x - (head * Math.cos(angle + offset)) / aspect) * 100,
      y: (mark.to.y - head * Math.sin(angle + offset)) * 100,
    };
  };
  const left = wing(-spread);
  const right = wing(spread);
  const shaft = `M ${mark.from.x * 100} ${mark.from.y * 100} L ${mark.to.x * 100} ${mark.to.y * 100}`;
  const arrowHead = `M ${left.x} ${left.y} L ${mark.to.x * 100} ${mark.to.y * 100} L ${right.x} ${right.y}`;

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      <path
        d={`${shaft} ${arrowHead}`}
        fill="none"
        stroke={STROKE_HALO_INNER}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        style={{ strokeWidth: 5 }}
      />
      <path
        d={`${shaft} ${arrowHead}`}
        fill="none"
        stroke={mark.ink}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        style={{ strokeWidth: 3 }}
      />
    </svg>
  );
}

function boxedFill(
  mark: Extract<ImageAnnotationMark, { shape: "box" | "highlight" | "redact" }>,
) {
  if (mark.shape === "redact") {
    return { background: REDACT_FILL };
  }
  if (mark.shape === "highlight") {
    return { background: HIGHLIGHT_FILL };
  }
  return {
    border: `2.5px solid ${mark.ink}`,
    background: `${mark.ink}1A`,
    boxShadow: `inset 0 0 0 1px ${STROKE_HALO_INNER}`,
  };
}

/**
 * Selection is carried entirely by the resize handles. An outline on top of the
 * mark's own border reads as two strokes around one shape, which looks like a
 * rendering fault rather than a state, so nothing here changes when a mark is
 * picked.
 */
export function MarkShape({
  mark,
  ordinal,
  aspect = 1,
  onSelect,
  onGrab,
}: {
  mark: ImageAnnotationMark;
  ordinal: number;
  aspect?: number;
  onSelect?: () => void;
  onGrab?: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  // Without a handler the mark is decoration, so it must not eat pointer events
  // from the surface underneath — that surface is where new marks get drawn.
  const interaction = onSelect
    ? {
        onClick: onSelect,
        ...(onGrab ? { onPointerDown: onGrab } : {}),
        className: "absolute cursor-move",
        "data-testid": `annotation-mark-${ordinal}`,
      }
    : { className: "pointer-events-none absolute" };

  if (mark.shape === "pen" || mark.shape === "arrow") {
    return <StrokeMark mark={mark} aspect={aspect} />;
  }

  if (mark.shape === "text") {
    return (
      <span
        {...interaction}
        style={{
          left: percent(mark.at.x),
          top: percent(mark.at.y),
          color: mark.ink,
          textShadow: `0 0 3px ${STROKE_HALO_INNER}, 0 0 3px ${STROKE_HALO_INNER}`,
        }}
      >
        <span className="whitespace-pre text-sm font-bold">{mark.text}</span>
      </span>
    );
  }

  return (
    <span
      {...interaction}
      style={{
        left: percent(mark.rect.x),
        top: percent(mark.rect.y),
        width: percent(mark.rect.width),
        height: percent(mark.rect.height),
        borderRadius: mark.shape === "box" ? 4 : 3,
        ...boxedFill(mark),
      }}
    >
      {mark.shape === "box" && (
        <span
          style={{ background: mark.ink }}
          className="absolute -left-[11px] -top-[11px] flex h-[22px] w-[22px] items-center justify-center rounded-full border-[1.5px] border-on-filled text-[11px] font-bold text-on-filled"
        >
          {ordinal}
        </span>
      )}
    </span>
  );
}

/**
 * A mark's note, drawn on the image itself rather than only travelling as text.
 *
 * The flattened copy is what the vision model actually looks at, so a sentence
 * that only exists in the prompt makes the model match words to regions by
 * position alone. Printed next to its mark, the instruction and the thing it is
 * about arrive together.
 */
export function MarkNoteLabel({
  mark,
  selected = false,
  onSelect,
  onGrab,
}: {
  mark: ImageAnnotationMark;
  selected?: boolean;
  onSelect?: () => void;
  onGrab?: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  const note = noteOnImage(mark);
  if (!note) {
    return null;
  }

  const interaction = onSelect
    ? {
        onClick: onSelect,
        ...(onGrab ? { onPointerDown: onGrab } : {}),
        className: "absolute cursor-move",
        "data-testid": `annotation-note-label-${mark.id}`,
      }
    : { className: "pointer-events-none absolute" };

  return (
    <span
      {...interaction}
      style={{
        left: percent(note.box.x),
        top: percent(note.box.y),
        width: percent(note.box.width),
        color: markInk(mark),
        // An image can be any colour under the text, so the label carries its
        // own ground rather than relying on a halo to separate it.
        background: NOTE_GROUND,
        borderColor: markInk(mark),
        ...(selected ? { outline: `2px solid ${markInk(mark)}` } : {}),
      }}
    >
      <span className="block whitespace-pre-wrap break-words rounded-md border px-1.5 py-1 text-[11px] font-semibold leading-snug">
        {note.text}
      </span>
    </span>
  );
}

/**
 * The read-only layer. Sits inside whatever element carries the image so the
 * normalized geometry lands on the same box the marks were drawn against.
 */
export function AnnotationMarkLayer({
  annotation,
  aspect = 1,
}: {
  annotation: ImageAnnotation;
  aspect?: number;
}) {
  return (
    <span
      className="pointer-events-none absolute inset-0"
      data-testid="annotation-mark-layer"
    >
      {annotation.marks.map((mark, index) => {
        return (
          <MarkShape
            key={mark.id}
            mark={mark}
            ordinal={markOrdinal(mark, index)}
            aspect={aspect}
          />
        );
      })}
      {annotation.marks.map((mark) => {
        return <MarkNoteLabel key={`${mark.id}-note`} mark={mark} />;
      })}
    </span>
  );
}
