import type {
  ImageAnnotation,
  ImageAnnotationMark,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  HIGHLIGHT_FILL,
  REDACT_FILL,
  STROKE_HALO_INNER,
  STROKE_HALO_OUTER,
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

function percent(value: number): string {
  return `${value * 100}%`;
}

function StrokeMark({ mark }: { mark: ImageAnnotationMark }) {
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
          stroke={STROKE_HALO_OUTER}
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

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      <line
        x1={mark.from.x * 100}
        y1={mark.from.y * 100}
        x2={mark.to.x * 100}
        y2={mark.to.y * 100}
        stroke={STROKE_HALO_OUTER}
        vectorEffect="non-scaling-stroke"
        style={{ strokeWidth: 5 }}
      />
      <line
        x1={mark.from.x * 100}
        y1={mark.from.y * 100}
        x2={mark.to.x * 100}
        y2={mark.to.y * 100}
        stroke={mark.ink}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        style={{ strokeWidth: 3 }}
      />
      <circle
        cx={mark.to.x * 100}
        cy={mark.to.y * 100}
        r={1.4}
        fill={mark.ink}
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
    boxShadow: `0 0 0 1px ${STROKE_HALO_OUTER}, inset 0 0 0 1px ${STROKE_HALO_INNER}`,
  };
}

export function MarkShape({
  mark,
  ordinal,
  selected = false,
  onSelect,
}: {
  mark: ImageAnnotationMark;
  ordinal: number;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const ring = selected
    ? { outline: `2px solid ${markInk(mark)}`, outlineOffset: "3px" }
    : {};
  // Without a handler the mark is decoration, so it must not eat pointer events
  // from the surface underneath — that surface is where new marks get drawn.
  const interaction = onSelect
    ? {
        onClick: onSelect,
        className: "absolute cursor-pointer",
        "data-testid": `annotation-mark-${ordinal}`,
      }
    : { className: "pointer-events-none absolute" };

  if (mark.shape === "pen" || mark.shape === "arrow") {
    return <StrokeMark mark={mark} />;
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
          ...ring,
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
        ...ring,
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
 * The read-only layer. Sits inside whatever element carries the image so the
 * normalized geometry lands on the same box the marks were drawn against.
 */
export function AnnotationMarkLayer({
  annotation,
}: {
  annotation: ImageAnnotation;
}) {
  return (
    <span
      className="pointer-events-none absolute inset-0"
      data-testid="annotation-mark-layer"
    >
      {annotation.marks.map((mark, index) => {
        return <MarkShape key={mark.id} mark={mark} ordinal={index + 1} />;
      })}
    </span>
  );
}
