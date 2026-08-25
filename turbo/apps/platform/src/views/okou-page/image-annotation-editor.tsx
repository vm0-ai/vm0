import type { PointerEvent as ReactPointerEvent } from "react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  Crop,
  Highlighter,
  MousePointer2,
  Pencil,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { Button } from "@okouai/ui/components/ui/button";
import { cn } from "@okouai/ui";
import type { ImageAnnotationMark } from "@okouai/api-contracts/contracts/chat-threads";
import {
  ANNOTATION_INKS,
  addAnnotationMark$,
  annotationCanRedo$,
  annotationCanUndo$,
  annotationDraft$,
  annotationInk$,
  annotationSelectedMarkId$,
  annotationSessionTarget$,
  annotationStroke$,
  annotationSurface$,
  annotationTool$,
  bindAnnotationSurface$,
  closeAnnotationEditor$,
  commitAnnotation$,
  HIGHLIGHT_FILL,
  redoAnnotation$,
  REDACT_FILL,
  removeAnnotationMark$,
  selectAnnotationMark$,
  setAnnotationCrop$,
  setAnnotationInk$,
  setAnnotationMarkNote$,
  setAnnotationStroke$,
  setAnnotationTool$,
  STROKE_HALO_INNER,
  STROKE_HALO_OUTER,
  undoAnnotation$,
  type AnnotationInk,
  type AnnotationPoint,
  type AnnotationStroke,
  type AnnotationTarget,
  type AnnotationTool,
} from "../../signals/okou-page/image-annotation.ts";
import { useResolvedAttachmentUrl } from "./attachment-resource.ts";

const TOOLS: readonly { tool: AnnotationTool; icon: typeof Square }[] = [
  { tool: "select", icon: MousePointer2 },
  { tool: "box", icon: Square },
  { tool: "arrow", icon: ArrowUpRight },
  { tool: "pen", icon: Pencil },
  { tool: "text", icon: Type },
  { tool: "highlight", icon: Highlighter },
  { tool: "redact", icon: Trash2 },
  { tool: "crop", icon: Crop },
];

/**
 * A drag shorter than this is a click, not a shape. Without the floor, every
 * stray click while a drawing tool is active would leave a zero-sized mark that
 * is impossible to see and impossible to select in order to delete.
 */
const MIN_DRAG = 0.005;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function rectFrom(a: AnnotationPoint, b: AnnotationPoint) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

function buildMark(
  stroke: AnnotationStroke,
  ink: AnnotationInk,
): ImageAnnotationMark | null {
  const id = crypto.randomUUID();
  const rect = rectFrom(stroke.from, stroke.to);
  const dragged = rect.width > MIN_DRAG || rect.height > MIN_DRAG;

  switch (stroke.tool) {
    case "box": {
      return dragged ? { id, shape: "box", rect, ink } : null;
    }
    case "highlight": {
      return dragged ? { id, shape: "highlight", rect } : null;
    }
    case "redact": {
      return dragged ? { id, shape: "redact", rect } : null;
    }
    case "arrow": {
      return dragged
        ? { id, shape: "arrow", from: stroke.from, to: stroke.to, ink }
        : null;
    }
    case "pen": {
      return stroke.points.length > 1
        ? { id, shape: "pen", points: [...stroke.points], ink }
        : null;
    }
    case "text": {
      return { id, shape: "text", at: stroke.from, text: "", ink };
    }
    case "crop": {
      return null;
    }
  }
}

function markInk(mark: ImageAnnotationMark): string {
  if (mark.shape === "highlight" || mark.shape === "redact") {
    return REDACT_FILL;
  }
  return mark.ink;
}

function noteOf(mark: ImageAnnotationMark): string {
  if (mark.shape === "text") {
    return mark.text;
  }
  if (mark.shape === "redact") {
    return "";
  }
  return mark.note ?? "";
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

function BoxedMark({
  mark,
  ordinal,
  selected,
  onSelect,
}: {
  mark: Extract<ImageAnnotationMark, { shape: "box" | "highlight" | "redact" }>;
  ordinal: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const fill =
    mark.shape === "redact"
      ? { background: REDACT_FILL }
      : mark.shape === "highlight"
        ? { background: HIGHLIGHT_FILL }
        : {
            border: `2.5px solid ${mark.ink}`,
            background: `${mark.ink}1A`,
            boxShadow: `0 0 0 1px ${STROKE_HALO_OUTER}, inset 0 0 0 1px ${STROKE_HALO_INNER}`,
          };

  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        left: percent(mark.rect.x),
        top: percent(mark.rect.y),
        width: percent(mark.rect.width),
        height: percent(mark.rect.height),
        borderRadius: mark.shape === "box" ? 4 : 3,
        ...fill,
        ...(selected
          ? { outline: `2px solid ${markInk(mark)}`, outlineOffset: "3px" }
          : {}),
      }}
      className="absolute"
    >
      {mark.shape === "box" && (
        <span
          style={{ background: mark.ink }}
          className="absolute -left-[11px] -top-[11px] flex h-[22px] w-[22px] items-center justify-center rounded-full border-[1.5px] border-white text-[11px] font-bold text-white shadow"
        >
          {ordinal}
        </span>
      )}
    </button>
  );
}

function MarkLayer({
  mark,
  ordinal,
  selected,
  onSelect,
}: {
  mark: ImageAnnotationMark;
  ordinal: number;
  selected: boolean;
  onSelect: () => void;
}) {
  if (mark.shape === "pen" || mark.shape === "arrow") {
    return <StrokeMark mark={mark} />;
  }

  if (mark.shape === "text") {
    return (
      <button
        type="button"
        onClick={onSelect}
        style={{
          left: percent(mark.at.x),
          top: percent(mark.at.y),
          color: mark.ink,
          textShadow: `0 0 3px ${STROKE_HALO_INNER}, 0 0 3px ${STROKE_HALO_INNER}`,
          ...(selected
            ? { outline: `2px solid ${mark.ink}`, outlineOffset: "3px" }
            : {}),
        }}
        className="absolute whitespace-pre text-sm font-bold"
      >
        {mark.text || "…"}
      </button>
    );
  }

  return (
    <BoxedMark
      mark={mark}
      ordinal={ordinal}
      selected={selected}
      onSelect={onSelect}
    />
  );
}

/**
 * Each label is reached through a literal accessor rather than an index on the
 * tool name: the i18n extractor reads these statically, and a dynamic lookup
 * would silently leave the keys out of every locale file.
 */
function useToolLabel(): (tool: AnnotationTool) => string {
  const { t } = useTranslation();
  return (tool: AnnotationTool): string => {
    switch (tool) {
      case "select": {
        return t(($) => {
          return $.artifacts.annotation.tools.select;
        });
      }
      case "box": {
        return t(($) => {
          return $.artifacts.annotation.tools.box;
        });
      }
      case "arrow": {
        return t(($) => {
          return $.artifacts.annotation.tools.arrow;
        });
      }
      case "pen": {
        return t(($) => {
          return $.artifacts.annotation.tools.pen;
        });
      }
      case "text": {
        return t(($) => {
          return $.artifacts.annotation.tools.text;
        });
      }
      case "highlight": {
        return t(($) => {
          return $.artifacts.annotation.tools.highlight;
        });
      }
      case "redact": {
        return t(($) => {
          return $.artifacts.annotation.tools.redact;
        });
      }
      case "crop": {
        return t(($) => {
          return $.artifacts.annotation.tools.crop;
        });
      }
    }
  };
}

function InkSwatches() {
  const ink = useGet(annotationInk$);
  const setInk = useSet(setAnnotationInk$);

  return (
    <div className="flex items-center gap-1.5 px-1">
      {ANNOTATION_INKS.map((candidate) => {
        const active = candidate === ink;
        return (
          <button
            key={candidate}
            type="button"
            onClick={() => {
              setInk(candidate);
            }}
            aria-pressed={active}
            aria-label={candidate}
            title={candidate}
            style={{
              background: candidate,
              boxShadow: active
                ? `0 0 0 2px hsl(var(--card)), 0 0 0 3.5px ${candidate}`
                : "0 0 0 1px hsl(var(--gray-300))",
            }}
            className={cn(
              "rounded-full transition-all",
              active ? "h-[18px] w-[18px]" : "h-4 w-4",
            )}
          />
        );
      })}
    </div>
  );
}

function ToolPill() {
  const tool = useGet(annotationTool$);
  const setTool = useSet(setAnnotationTool$);
  const toolLabel = useToolLabel();

  return (
    <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-border bg-background p-1.5 shadow-lg">
      {TOOLS.map(({ tool: candidate, icon: Icon }) => {
        return (
          <Button
            key={candidate}
            type="button"
            variant="quiet"
            size="icon-sm"
            aria-pressed={tool === candidate}
            aria-label={toolLabel(candidate)}
            title={toolLabel(candidate)}
            onClick={() => {
              setTool(candidate);
            }}
            className={cn(
              tool === candidate && "bg-foreground text-background",
            )}
          >
            <Icon size={16} />
          </Button>
        );
      })}
      <span className="mx-1 h-[18px] w-px bg-border" />
      <InkSwatches />
    </div>
  );
}

function NoteField({ mark }: { mark: ImageAnnotationMark }) {
  const { t } = useTranslation();
  const setNote = useSet(setAnnotationMarkNote$);
  const removeMark = useSet(removeAnnotationMark$);

  return (
    <div className="flex items-center gap-2 border-t border-border bg-card px-4 py-2.5">
      <span
        style={{ background: markInk(mark) }}
        className="h-2.5 w-2.5 shrink-0 rounded-full"
      />
      <input
        value={noteOf(mark)}
        onChange={(event) => {
          setNote(mark.id, event.target.value);
        }}
        placeholder={t(($) => {
          return $.artifacts.annotation.notePlaceholder;
        })}
        className="h-8 flex-1 rounded-lg border border-border bg-input px-3 text-sm"
      />
      <Button
        type="button"
        variant="quiet"
        size="icon-sm"
        onClick={() => {
          removeMark(mark.id);
        }}
        aria-label={t(($) => {
          return $.artifacts.annotation.removeMark;
        })}
      >
        <Trash2 size={16} />
      </Button>
    </div>
  );
}

function EditorHeader({ filename }: { filename: string }) {
  const { t } = useTranslation();
  const annotation = useGet(annotationDraft$);
  const canUndo = useGet(annotationCanUndo$);
  const canRedo = useGet(annotationCanRedo$);
  const undo = useSet(undoAnnotation$);
  const redo = useSet(redoAnnotation$);
  const close = useSet(closeAnnotationEditor$);

  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 pl-4 pr-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{filename}</div>
        <div className="truncate text-xs text-muted-foreground">
          {t(
            ($) => {
              return $.artifacts.annotation.subtitle;
            },
            { count: annotation.marks.length },
          )}
        </div>
      </div>
      <Button
        type="button"
        variant="quiet"
        size="icon-sm"
        disabled={!canUndo}
        onClick={undo}
        aria-label={t(($) => {
          return $.artifacts.annotation.undo;
        })}
      >
        <Undo2 size={18} />
      </Button>
      <Button
        type="button"
        variant="quiet"
        size="icon-sm"
        disabled={!canRedo}
        onClick={redo}
        aria-label={t(($) => {
          return $.artifacts.annotation.redo;
        })}
      >
        <Redo2 size={18} />
      </Button>
      <Button
        type="button"
        variant="quiet"
        size="icon-sm"
        onClick={close}
        aria-label={t(($) => {
          return $.artifacts.actions.close;
        })}
      >
        <X size={18} />
      </Button>
    </div>
  );
}

function EditorFooter() {
  const { t } = useTranslation();
  const close = useSet(closeAnnotationEditor$);
  const commit = useSet(commitAnnotation$);

  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-t border-border bg-card px-4">
      <span className="text-xs text-muted-foreground">
        {t(($) => {
          return $.artifacts.annotation.draftOnly;
        })}
      </span>
      <div className="flex-1" />
      <Button type="button" variant="quiet" size="sm" onClick={close}>
        {t(($) => {
          return $.chat.actions.cancel;
        })}
      </Button>
      <Button type="button" size="sm" onClick={commit}>
        {t(($) => {
          return $.artifacts.annotation.attach;
        })}
      </Button>
    </div>
  );
}

interface StrokeHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: () => void;
}

function useStrokeHandlers(): StrokeHandlers {
  const tool = useGet(annotationTool$);
  const ink = useGet(annotationInk$);
  const stroke = useGet(annotationStroke$);
  const surface = useGet(annotationSurface$);
  const setStroke = useSet(setAnnotationStroke$);
  const addMark = useSet(addAnnotationMark$);
  const selectMark = useSet(selectAnnotationMark$);
  const setTool = useSet(setAnnotationTool$);
  const setCrop = useSet(setAnnotationCrop$);

  const pointAt = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = surface?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) {
      return null;
    }
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    };
  };

  return {
    onPointerDown: (event) => {
      if (tool === "select") {
        selectMark(null);
        return;
      }
      const point = pointAt(event);
      if (!point) {
        return;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      setStroke({ tool, from: point, to: point, points: [point] });
    },
    onPointerMove: (event) => {
      if (!stroke) {
        return;
      }
      const point = pointAt(event);
      if (!point) {
        return;
      }
      setStroke({
        ...stroke,
        to: point,
        points:
          stroke.tool === "pen" ? [...stroke.points, point] : stroke.points,
      });
    },
    onPointerUp: () => {
      if (!stroke) {
        return;
      }
      if (stroke.tool === "crop") {
        const rect = rectFrom(stroke.from, stroke.to);
        if (rect.width > MIN_DRAG && rect.height > MIN_DRAG) {
          setCrop(rect);
        }
        setStroke(null);
        return;
      }
      const mark = buildMark(stroke, ink);
      if (mark) {
        addMark(mark);
        // A text mark is useless until it has words, so the note field is where
        // the user lands the moment the mark exists.
        if (mark.shape === "text") {
          setTool("select");
        }
      }
      setStroke(null);
    },
  };
}

function EditorStage({ filename, url }: { filename: string; url: string }) {
  const annotation = useGet(annotationDraft$);
  const tool = useGet(annotationTool$);
  const ink = useGet(annotationInk$);
  const stroke = useGet(annotationStroke$);
  const selectedId = useGet(annotationSelectedMarkId$);
  const selectMark = useSet(selectAnnotationMark$);
  const setTool = useSet(setAnnotationTool$);
  const bindSurface = useSet(bindAnnotationSurface$);
  const handlers = useStrokeHandlers();

  const preview =
    stroke && stroke.tool !== "pen" ? rectFrom(stroke.from, stroke.to) : null;

  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/30 p-5">
      <div
        ref={bindSurface}
        onPointerDown={handlers.onPointerDown}
        onPointerMove={handlers.onPointerMove}
        onPointerUp={handlers.onPointerUp}
        style={{ touchAction: "none" }}
        className={cn(
          "relative max-h-full max-w-full select-none",
          tool === "select" ? "cursor-default" : "cursor-crosshair",
        )}
        data-testid="image-annotation-surface"
      >
        <img
          src={url}
          alt={filename}
          draggable={false}
          className="block max-h-[min(560px,70vh)] max-w-full rounded-lg object-contain"
        />
        {annotation.crop && (
          <div
            style={{
              left: percent(annotation.crop.x),
              top: percent(annotation.crop.y),
              width: percent(annotation.crop.width),
              height: percent(annotation.crop.height),
              boxShadow: "0 0 0 9999px rgba(20,23,29,.55)",
              outline: `2px solid ${ink}`,
            }}
            className="pointer-events-none absolute rounded-sm"
          />
        )}
        {annotation.marks.map((mark, index) => {
          return (
            <MarkLayer
              key={mark.id}
              mark={mark}
              ordinal={index + 1}
              selected={mark.id === selectedId}
              onSelect={() => {
                selectMark(mark.id);
                setTool("select");
              }}
            />
          );
        })}
        {preview && (
          <div
            style={{
              left: percent(preview.x),
              top: percent(preview.y),
              width: percent(preview.width),
              height: percent(preview.height),
              border: `2.5px dashed ${ink}`,
            }}
            className="pointer-events-none absolute rounded"
          />
        )}
      </div>
      <ToolPill />
    </div>
  );
}

/**
 * Mounted at the app root, so it must not touch page-scoped state until a
 * session actually exists — `useResolvedAttachmentUrl` reads the resolver that
 * belongs to the current page, and reaching for it before any page is set up
 * throws. Splitting the surface into its own component keeps that read behind
 * the session check.
 */
export function ImageAnnotationEditor() {
  const target = useGet(annotationSessionTarget$);
  if (!target) {
    return null;
  }
  return <AnnotationSurface target={target} />;
}

function AnnotationSurface({ target }: { target: AnnotationTarget }) {
  const annotation = useGet(annotationDraft$);
  const selectedId = useGet(annotationSelectedMarkId$);
  const resolvedUrl = useResolvedAttachmentUrl(target.url);

  if (resolvedUrl === null) {
    return null;
  }

  const selectedMark = annotation.marks.find((mark) => {
    return mark.id === selectedId;
  });

  return (
    <div
      className="zero-app fixed inset-0 z-50 flex items-center justify-center bg-gray-900/45 p-6"
      data-testid="image-annotation-editor"
    >
      <div className="flex h-[min(700px,90vh)] w-[min(980px,94vw)] min-h-0 flex-col overflow-hidden rounded-2xl bg-background text-foreground shadow-[0_24px_70px_rgba(0,0,0,0.30)]">
        <EditorHeader filename={target.filename} />
        <EditorStage filename={target.filename} url={resolvedUrl} />
        {selectedMark && selectedMark.shape !== "redact" && (
          <NoteField mark={selectedMark} />
        )}
        <EditorFooter />
      </div>
    </div>
  );
}
