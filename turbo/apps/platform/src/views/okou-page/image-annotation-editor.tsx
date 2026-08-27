import type { PointerEvent as ReactPointerEvent } from "react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  Minus,
  Pencil,
  Plus,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { Button } from "@okouai/ui/components/ui/button";
import { Input } from "@okouai/ui/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui/components/ui/tooltip";
import { cn } from "@okouai/ui";
import type { ImageAnnotationMark } from "@okouai/api-contracts/contracts/chat-threads";
import {
  ANNOTATION_INKS,
  addAnnotationMark$,
  annotationCanRedo$,
  annotationCanUndo$,
  annotationDraft$,
  annotationDrag$,
  annotationInk$,
  annotationSelectedMarkId$,
  annotationSessionTarget$,
  annotationStroke$,
  annotationSurface$,
  annotationTool$,
  annotationZoom$,
  bindAnnotationSurface$,
  closeAnnotationEditor$,
  commitAnnotation$,
  redoAnnotation$,
  removeAnnotationMark$,
  removeSelectedAnnotationMark$,
  selectAnnotationMark$,
  setAnnotationInk$,
  setAnnotationMarkNote$,
  setAnnotationStroke$,
  setAnnotationDrag$,
  setAnnotationTool$,
  moveAnnotationMarkRect$,
  resetAnnotationZoom$,
  undoAnnotation$,
  zoomAnnotation$,
  type AnnotationDrag,
  type AnnotationInk,
  type AnnotationPoint,
  type AnnotationStroke,
  type AnnotationTarget,
  type AnnotationTool,
} from "../../signals/okou-page/image-annotation.ts";
import { useResolvedAttachmentUrl } from "./attachment-resource.ts";
import { markInk, MarkShape } from "./image-annotation-marks.tsx";

const TOOLS: readonly { tool: AnnotationTool; icon: typeof Square }[] = [
  { tool: "box", icon: Square },
  { tool: "arrow", icon: ArrowUpRight },
  { tool: "pen", icon: Pencil },
  { tool: "text", icon: Type },
];

/**
 * A drag shorter than this is a click, not a shape. Without the floor, every
 * stray click while a drawing tool is active would leave a zero-sized mark that
 * is impossible to see and impossible to select in order to delete.
 */
const MIN_DRAG = 0.005;

/** One letter per tool, matching the first letter of each label. */
const TOOL_SHORTCUTS: Readonly<Record<string, AnnotationTool | undefined>> = {
  b: "box",
  a: "arrow",
  d: "pen",
  t: "text",
};

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

function percent(value: number): string {
  return `${value * 100}%`;
}

function buildMark(
  stroke: AnnotationStroke,
  ink: AnnotationInk,
  previewId?: string,
): ImageAnnotationMark | null {
  const id = previewId ?? crypto.randomUUID();
  const rect = rectFrom(stroke.from, stroke.to);
  const dragged = rect.width > MIN_DRAG || rect.height > MIN_DRAG;

  switch (stroke.tool) {
    case "box": {
      return dragged ? { id, shape: "box", rect, ink } : null;
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
  }
}

function noteOf(mark: ImageAnnotationMark): string {
  if (mark.shape === "text") {
    return mark.text;
  }
  if (mark.shape === "highlight" || mark.shape === "redact") {
    return "";
  }
  return mark.note ?? "";
}

function markAnchor(mark: ImageAnnotationMark): AnnotationPoint {
  if (mark.shape === "text") {
    return mark.at;
  }
  if (mark.shape === "arrow") {
    return mark.to;
  }
  if (mark.shape === "pen") {
    return mark.points[0] ?? { x: 0.5, y: 0.5 };
  }
  return { x: mark.rect.x, y: mark.rect.y + mark.rect.height };
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
    }
  };
}

function InkSwatches() {
  const { t } = useTranslation();
  const ink = useGet(annotationInk$);
  const setInk = useSet(setAnnotationInk$);

  return (
    <div className="flex items-center gap-0.5 px-1">
      {ANNOTATION_INKS.map((candidate) => {
        const active = candidate === ink;
        return (
          <Tooltip key={candidate}>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="quiet"
                  size="icon-xs"
                  aria-pressed={active}
                  aria-label={t(
                    ($) => {
                      return $.artifacts.annotation.inkLabel;
                    },
                    { color: candidate },
                  )}
                  onClick={() => {
                    setInk(candidate);
                  }}
                  className={cn(active && "bg-state-selected")}
                >
                  <span
                    style={{
                      background: candidate,
                      // The ring is the ink itself, held off the swatch by the
                      // toolbar colour, so the selected colour is announced by
                      // the colour rather than by two pixels of extra diameter.
                      boxShadow: active
                        ? `0 0 0 2px hsl(var(--background)), 0 0 0 4px ${candidate}`
                        : "none",
                    }}
                    className={cn(
                      "rounded-full transition-all",
                      active ? "h-3.5 w-3.5" : "h-4 w-4",
                    )}
                  />
                </Button>
              }
            />
            <TooltipContent>{candidate}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

function ZoomControls() {
  const { t } = useTranslation();
  const zoom = useGet(annotationZoom$);
  const zoomBy = useSet(zoomAnnotation$);
  const resetZoom = useSet(resetAnnotationZoom$);

  return (
    <div className="absolute right-4 top-4 z-20 flex items-center gap-1 rounded-lg border border-border bg-background px-1.5 py-1 shadow-sm">
      <Button
        showTooltip
        type="button"
        variant="quiet"
        size="icon-xs"
        onClick={() => {
          zoomBy(-1);
        }}
        aria-label={t(($) => {
          return $.artifacts.actions.zoomOut;
        })}
      >
        <Minus size={14} />
      </Button>
      <button
        type="button"
        onClick={resetZoom}
        className="min-w-10 rounded-md px-1 text-center text-xs font-medium tabular-nums text-foreground transition-colors hover:bg-state-hover"
      >
        {Math.round(zoom * 100)}%
      </button>
      <Button
        showTooltip
        type="button"
        variant="quiet"
        size="icon-xs"
        onClick={() => {
          zoomBy(1);
        }}
        aria-label={t(($) => {
          return $.artifacts.actions.zoomIn;
        })}
      >
        <Plus size={14} />
      </Button>
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
          <Tooltip key={candidate}>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="quiet"
                  size="icon-sm"
                  aria-pressed={tool === candidate}
                  aria-label={toolLabel(candidate)}
                  onClick={() => {
                    setTool(candidate);
                  }}
                  className={cn(
                    tool === candidate &&
                      "bg-state-selected text-foreground hover:bg-state-selected-hover",
                  )}
                >
                  <Icon size={16} />
                </Button>
              }
            />
            <TooltipContent>{toolLabel(candidate)}</TooltipContent>
          </Tooltip>
        );
      })}
      <span className="mx-1 h-[18px] w-px bg-border" />
      <InkSwatches />
    </div>
  );
}

/**
 * The note lives next to the mark it belongs to rather than in a bar at the
 * bottom of the dialog: a field detached from the thing it describes gives no
 * clue which mark is being edited, and text marks were being typed twice —
 * once on the image and once underneath it.
 */
function MarkNotePopover({ mark }: { mark: ImageAnnotationMark }) {
  const { t } = useTranslation();
  const setNote = useSet(setAnnotationMarkNote$);
  const removeMark = useSet(removeAnnotationMark$);
  const deselect = useSet(selectAnnotationMark$);
  const anchor = markAnchor(mark);

  return (
    <div
      style={{ left: percent(anchor.x), top: percent(anchor.y) }}
      // The popover lives inside the drawing surface so it can be positioned
      // against the mark, which means its own clicks would otherwise start a
      // stroke on the canvas underneath it.
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      onPointerUp={(event) => {
        event.stopPropagation();
      }}
      className="absolute z-30 w-[248px] translate-y-2 rounded-xl border border-border bg-popover p-2 shadow-lg"
      data-testid="annotation-note-popover"
    >
      <div className="flex items-center gap-2">
        <span
          style={{ background: markInk(mark) }}
          className="h-2.5 w-2.5 shrink-0 rounded-full"
        />
        <Input
          // Only text marks take the caret. Focusing the field for every mark
          // is what made Delete land in the input instead of removing the mark.
          autoFocus={mark.shape === "text"}
          value={noteOf(mark)}
          onChange={(event) => {
            setNote(mark.id, event.target.value);
          }}
          onKeyDown={(event) => {
            // Backspace edits the text. Once the field is empty the next press
            // dismisses the note — deleting the mark from here would be a
            // surprise, so that stays on the bin button alone.
            if (
              (event.key === "Backspace" || event.key === "Delete") &&
              noteOf(mark).length === 0
            ) {
              event.preventDefault();
              deselect(null);
            }
          }}
          placeholder={
            mark.shape === "text"
              ? t(($) => {
                  return $.artifacts.annotation.textPlaceholder;
                })
              : t(($) => {
                  return $.artifacts.annotation.notePlaceholder;
                })
          }
          className="h-8 flex-1 text-sm"
        />
        <Button
          showTooltip
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
      <Tooltip>
        <TooltipTrigger
          render={
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
          }
        />
        <TooltipContent>
          {t(($) => {
            return $.artifacts.annotation.undo;
          })}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
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
          }
        />
        <TooltipContent>
          {t(($) => {
            return $.artifacts.annotation.redo;
          })}
        </TooltipContent>
      </Tooltip>
      <Button
        showTooltip
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

/**
 * The editor's keyboard surface. Every binding steps aside while a field has
 * focus, so typing a note never triggers a shortcut.
 */
function KeyboardShortcuts() {
  const removeSelected = useSet(removeSelectedAnnotationMark$);
  const selectMark = useSet(selectAnnotationMark$);
  const setTool = useSet(setAnnotationTool$);
  const undo = useSet(undoAnnotation$);
  const redo = useSet(redoAnnotation$);
  const close = useSet(closeAnnotationEditor$);
  const commit = useSet(commitAnnotation$);
  const selectedId = useGet(annotationSelectedMarkId$);
  let cleanup: (() => void) | null = null;

  return (
    <span
      ref={(node) => {
        cleanup?.();
        cleanup = null;
        if (!node) {
          return;
        }
        const onKeyDown = (event: KeyboardEvent) => {
          const active = document.activeElement;
          const typing =
            active instanceof HTMLInputElement ||
            active instanceof HTMLTextAreaElement ||
            (active instanceof HTMLElement && active.isContentEditable);

          if (
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === "z"
          ) {
            event.preventDefault();
            if (event.shiftKey) {
              redo();
            } else {
              undo();
            }
            return;
          }
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            commit();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            // Escape backs out one layer at a time: the selection first, the
            // editor only once nothing is selected.
            if (selectedId) {
              selectMark(null);
            } else {
              close();
            }
            return;
          }
          if (typing) {
            return;
          }
          if (event.key === "Delete" || event.key === "Backspace") {
            event.preventDefault();
            removeSelected();
            return;
          }
          const shortcut = TOOL_SHORTCUTS[event.key.toLowerCase()];
          if (shortcut) {
            event.preventDefault();
            setTool(shortcut);
          }
        };
        document.addEventListener("keydown", onKeyDown, true);
        cleanup = () => {
          document.removeEventListener("keydown", onKeyDown, true);
        };
      }}
      hidden
    />
  );
}

interface StrokeHandlers {
  beginDrag: (drag: AnnotationDrag) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (
    event: ReactPointerEvent<HTMLDivElement>,
    moveRect: (
      id: string,
      rect: { x: number; y: number; width: number; height: number },
    ) => void,
  ) => void;
  onPointerUp: () => void;
}

function draggedRect(drag: AnnotationDrag, point: AnnotationPoint) {
  const dx = point.x - drag.origin.x;
  const dy = point.y - drag.origin.y;
  const start = drag.startRect;

  if (drag.mode === "move") {
    return {
      x: clamp01(start.x + dx),
      y: clamp01(start.y + dy),
      width: start.width,
      height: start.height,
    };
  }

  const left = drag.corner === "tl" || drag.corner === "bl";
  const top = drag.corner === "tl" || drag.corner === "tr";
  const x1 = left ? start.x + dx : start.x;
  const y1 = top ? start.y + dy : start.y;
  const x2 = left ? start.x + start.width : start.x + start.width + dx;
  const y2 = top ? start.y + start.height : start.y + start.height + dy;
  return {
    x: clamp01(Math.min(x1, x2)),
    y: clamp01(Math.min(y1, y2)),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

function useStrokeHandlers(): StrokeHandlers {
  const tool = useGet(annotationTool$);
  const ink = useGet(annotationInk$);
  const stroke = useGet(annotationStroke$);
  const drag = useGet(annotationDrag$);
  const surface = useGet(annotationSurface$);
  const setStroke = useSet(setAnnotationStroke$);
  const setDrag = useSet(setAnnotationDrag$);
  const addMark = useSet(addAnnotationMark$);
  const selectMark = useSet(selectAnnotationMark$);

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
    beginDrag: setDrag,
    onPointerDown: (event) => {
      const point = pointAt(event);
      if (!point) {
        return;
      }
      // Starting a stroke on bare canvas also clears the selection, so the
      // handles and note of the previous mark do not linger over a new one.
      selectMark(null);
      event.currentTarget.setPointerCapture(event.pointerId);
      setStroke({ tool, from: point, to: point, points: [point] });
    },
    onPointerMove: (event, moveRect) => {
      const point = pointAt(event);
      if (!point) {
        return;
      }
      if (drag) {
        moveRect(drag.markId, draggedRect(drag, point));
        return;
      }
      if (!stroke) {
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
      if (drag) {
        setDrag(null);
        return;
      }
      if (!stroke) {
        return;
      }
      const mark = buildMark(stroke, ink);
      if (mark) {
        // Adding selects the mark, so its note opens straight away — a shape
        // and the sentence explaining it are one gesture. The tool stays put,
        // so several boxes in a row do not need it re-picked.
        addMark(mark);
      }
      setStroke(null);
    },
  };
}

const RESIZE_CORNERS = ["tl", "tr", "bl", "br"] as const;

type ResizeCorner = (typeof RESIZE_CORNERS)[number];

function rectOf(mark: ImageAnnotationMark) {
  if (mark.shape === "box") {
    return mark.rect;
  }
  if (mark.shape === "text") {
    return { x: mark.at.x, y: mark.at.y, width: 0, height: 0 };
  }
  return null;
}

function cornerCursor(corner: ResizeCorner): string {
  return corner === "tl" || corner === "br"
    ? "cursor-nwse-resize"
    : "cursor-nesw-resize";
}

/**
 * Handles only appear for marks that have a rectangle. A freehand stroke or an
 * arrow can still be selected and deleted; resizing them would mean editing
 * every point, which is not what a handle promises.
 */
function ResizeHandles({
  mark,
  onGrab,
}: {
  mark: ImageAnnotationMark;
  onGrab: (corner: ResizeCorner, event: ReactPointerEvent<HTMLElement>) => void;
}) {
  const rect = rectOf(mark);
  if (!rect || rect.width === 0) {
    return null;
  }

  return (
    <>
      {RESIZE_CORNERS.map((corner) => {
        const x =
          corner === "tl" || corner === "bl" ? rect.x : rect.x + rect.width;
        const y =
          corner === "tl" || corner === "tr" ? rect.y : rect.y + rect.height;
        return (
          <span
            key={corner}
            role="presentation"
            onPointerDown={(event) => {
              onGrab(corner, event);
            }}
            style={{ left: percent(x), top: percent(y) }}
            className={cn(
              "absolute -ml-[5px] -mt-[5px] h-2.5 w-2.5 rounded-sm border border-border bg-background shadow-sm",
              cornerCursor(corner),
            )}
            data-testid={`annotation-handle-${corner}`}
          />
        );
      })}
    </>
  );
}

function EditorStage({ filename, url }: { filename: string; url: string }) {
  const annotation = useGet(annotationDraft$);
  const ink = useGet(annotationInk$);
  const stroke = useGet(annotationStroke$);
  const zoom = useGet(annotationZoom$);
  const surface = useGet(annotationSurface$);
  const selectedId = useGet(annotationSelectedMarkId$);
  const selectMark = useSet(selectAnnotationMark$);
  const bindSurface = useSet(bindAnnotationSurface$);
  const moveRect = useSet(moveAnnotationMarkRect$);
  const handlers = useStrokeHandlers();

  const box = surface?.getBoundingClientRect();
  const aspect = box && box.height > 0 ? box.width / box.height : 1;
  // Previewing through the same renderer is what makes a drag show the arrow or
  // the freehand line it is about to become, rather than a dashed rectangle
  // standing in for every tool.
  const preview = stroke ? buildMark(stroke, ink, "annotation-preview") : null;
  const selectedMark = annotation.marks.find((mark) => {
    return mark.id === selectedId;
  });

  const grabHandle = (
    corner: ResizeCorner,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    // The handle sits on the drawing surface, so without this the grab also
    // starts a new stroke underneath the mark being resized.
    event.stopPropagation();
    if (!selectedMark) {
      return;
    }
    const rect = rectOf(selectedMark);
    const bounds = surface?.getBoundingClientRect();
    if (!rect || !bounds || bounds.width === 0) {
      return;
    }
    handlers.beginDrag({
      markId: selectedMark.id,
      mode: "resize",
      corner,
      origin: {
        x: (event.clientX - bounds.left) / bounds.width,
        y: (event.clientY - bounds.top) / bounds.height,
      },
      startRect: rect,
    });
  };

  const grabMark = (
    mark: ImageAnnotationMark,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    event.stopPropagation();
    selectMark(mark.id);
    const rect = rectOf(mark);
    const bounds = surface?.getBoundingClientRect();
    if (!rect || !bounds || bounds.width === 0) {
      return;
    }
    handlers.beginDrag({
      markId: mark.id,
      mode: "move",
      origin: {
        x: (event.clientX - bounds.left) / bounds.width,
        y: (event.clientY - bounds.top) / bounds.height,
      },
      startRect: rect,
    });
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/30">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-5">
        <div
          ref={bindSurface}
          onPointerDown={handlers.onPointerDown}
          onPointerMove={(event) => {
            handlers.onPointerMove(event, moveRect);
          }}
          onPointerUp={handlers.onPointerUp}
          style={{ touchAction: "none" }}
          className="relative shrink-0 cursor-crosshair select-none"
          data-testid="image-annotation-surface"
        >
          <img
            src={url}
            alt={filename}
            draggable={false}
            // The fit bounds are the stage's own box, so 100% zoom shows the
            // whole image and zooming grows the layout box the stage scrolls.
            style={{
              maxWidth: `calc(min(880px, 88vw) * ${zoom})`,
              maxHeight: `calc(min(520px, 62vh) * ${zoom})`,
            }}
            className="block rounded-lg object-contain"
          />
          {annotation.marks.map((mark, index) => {
            return (
              <MarkShape
                key={mark.id}
                mark={mark}
                ordinal={index + 1}
                aspect={aspect}
                selected={mark.id === selectedId}
                onSelect={() => {
                  selectMark(mark.id);
                }}
                onGrab={(event) => {
                  grabMark(mark, event);
                }}
              />
            );
          })}
          {selectedMark && (
            <ResizeHandles mark={selectedMark} onGrab={grabHandle} />
          )}
          {selectedMark && <MarkNotePopover mark={selectedMark} />}
          {preview && (
            <MarkShape
              mark={preview}
              ordinal={annotation.marks.length + 1}
              aspect={aspect}
            />
          )}
        </div>
      </div>
      <ZoomControls />
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
  const resolvedUrl = useResolvedAttachmentUrl(target.url);

  if (resolvedUrl === null) {
    return null;
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className="zero-app fixed inset-0 z-50 flex items-center justify-center bg-gray-900/45 p-6"
        data-testid="image-annotation-editor"
      >
        <KeyboardShortcuts />
        <div
          className="flex h-[min(700px,90vh)] w-[min(980px,94vw)] min-h-0 flex-col overflow-hidden rounded-xl bg-background text-foreground shadow-[0_24px_70px_hsl(var(--overlay)/0.30)]"
          data-testid="image-annotation-panel"
        >
          <EditorHeader filename={target.filename} />
          <EditorStage filename={target.filename} url={resolvedUrl} />
          <EditorFooter />
        </div>
      </div>
    </TooltipProvider>
  );
}
