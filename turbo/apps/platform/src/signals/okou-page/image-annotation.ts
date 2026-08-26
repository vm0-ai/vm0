import { command, computed, state } from "ccstate";
import { onRef } from "../utils.ts";
import type {
  ImageAnnotation,
  ImageAnnotationMark,
} from "@okouai/api-contracts/contracts/chat-threads";

/**
 * Ink drawn onto a *user's* screenshot cannot come from `--primary-*` or
 * `--gray-*`: those ramps are theme-relative and invert in dark mode, so one
 * pen would paint two different colours depending on which theme the app
 * happens to be in — while the screenshot underneath does not follow our theme
 * at all. These are the fixed-hex chart tokens (`--color-usage-kind-*` /
 * `--color-credit-*`), which are declared once with no dark override.
 *
 * The brand orange and the destructive red are deliberately absent: orange
 * collides with the orange buttons that appear inside vm0's own screenshots,
 * and red sits only 20° away from it while already meaning "danger" elsewhere.
 */
export const ANNOTATION_INKS = [
  "#5E6AD2", // usage-kind-model  — contrast 4.70 on white, 3.81 on near-black
  "#358A8E", // usage-kind-video
  "#6B8DE3", // credit-plan-team
  "#EC70A5", // usage-kind-image
  "#EDC43E", // credit-plan-pro
] as const;

export type AnnotationInk = (typeof ANNOTATION_INKS)[number];

/** The only candidate clearing 3:1 against both white and near-black unaided. */
export const DEFAULT_ANNOTATION_INK: AnnotationInk = "#5E6AD2";

/** A highlight is a wash under existing text — the one place yellow belongs. */
export const HIGHLIGHT_FILL = "rgba(237, 196, 62, 0.32)";

/** Redaction is opaque `gray-800`. Never translucent: covered must mean covered. */
export const REDACT_FILL = "#525B68";

/**
 * A mark is drawn in ink alone. An earlier version carried a dark outer halo
 * for contrast on busy imagery, but it read as a grey outline around every
 * shape, which is worse than the problem it solved. The light halo stays: it is
 * invisible on a white screenshot and does the separating work on a dark one.
 */
export const STROKE_HALO_INNER = "rgba(255, 255, 255, 0.90)";

/**
 * `highlight` and `crop` were dropped, and `select` with them: a mark is
 * clicked directly, so a mode for "not drawing" has nothing left to do. The
 * *shapes* stay in the contract — a draft saved before this change can still
 * carry a highlight or a crop, and it has to keep rendering.
 */
export type AnnotationTool = "box" | "arrow" | "pen" | "text" | "redact";

function emptyAnnotation(): ImageAnnotation {
  return { marks: [] };
}

export function annotationMarkCount(
  annotation: ImageAnnotation | null | undefined,
): number {
  return annotation?.marks.length ?? 0;
}

/**
 * True once the annotation would change any pixel or carry any words. An
 * annotation that has been opened and closed without drawing must not make the
 * send path flatten a copy of an image nobody marked.
 */
export function isAnnotationMeaningful(
  annotation: ImageAnnotation | null | undefined,
): boolean {
  if (!annotation) {
    return false;
  }
  return annotation.marks.length > 0 || annotation.crop !== undefined;
}

function markNote(mark: ImageAnnotationMark): string | undefined {
  if (mark.shape === "text") {
    return mark.text;
  }
  if (mark.shape === "redact") {
    return undefined;
  }
  return mark.note;
}

function markLocation(mark: ImageAnnotationMark): string {
  const percent = (value: number) => {
    return `${Math.round(value * 100)}%`;
  };
  if (mark.shape === "arrow") {
    return `pointing at ${percent(mark.to.x)}, ${percent(mark.to.y)}`;
  }
  if (mark.shape === "pen") {
    const first = mark.points[0];
    return first
      ? `around ${percent(first.x)}, ${percent(first.y)}`
      : "on the image";
  }
  if (mark.shape === "text") {
    return `at ${percent(mark.at.x)}, ${percent(mark.at.y)}`;
  }
  return `at ${percent(mark.rect.x)}, ${percent(mark.rect.y)} sized ${percent(
    mark.rect.width,
  )} × ${percent(mark.rect.height)}`;
}

/**
 * The half of an annotation that reaches the agent as words.
 *
 * The flattened image alone leaves the model to work out what a box means; the
 * value of a mark is which region it encloses and what the user said about it,
 * so the numbered notes travel as text next to the pixels. Marks the user drew
 * without a note still get a line — the ordinal is what lets the agent match a
 * sentence in the prompt to a numbered pin in the image.
 */
export function describeAnnotation(
  filename: string,
  annotation: ImageAnnotation,
): string | null {
  const lines = annotation.marks.flatMap((mark, index) => {
    if (mark.shape === "redact") {
      return [];
    }
    const note = markNote(mark)?.trim();
    const ordinal = index + 1;
    return [
      note
        ? `${ordinal}. (${mark.shape} ${markLocation(mark)}) ${note}`
        : `${ordinal}. (${mark.shape} ${markLocation(mark)})`,
    ];
  });

  if (lines.length === 0) {
    return null;
  }

  return [`Marks on ${filename}:`, ...lines].join("\n");
}

// ---------------------------------------------------------------------------
// Editor session — one attachment at a time, with its own undo history
// ---------------------------------------------------------------------------

/**
 * What the editor needs in order to edit, kept deliberately narrow so this
 * module never has to know about drafts. `commit` is what makes the model
 * non-destructive: the editor hands back marks, and the caller decides where
 * they live. The original bytes are not part of this interface at all.
 */
export interface AnnotationTarget {
  readonly key: string;
  readonly filename: string;
  readonly url: string;
  readonly annotation: ImageAnnotation | null;
  readonly commit: (annotation: ImageAnnotation | null) => void;
}

interface AnnotationSession {
  readonly target: AnnotationTarget;
  readonly past: readonly ImageAnnotation[];
  readonly present: ImageAnnotation;
  readonly future: readonly ImageAnnotation[];
}

/**
 * The stroke being dragged right now, and the element it is being dragged on.
 *
 * Both live here rather than in React state because this app has no React
 * hooks — every piece of state is a ccstate signal, and DOM nodes arrive
 * through `onRef`.
 */
export interface AnnotationStroke {
  readonly tool: Exclude<AnnotationTool, "select">;
  readonly from: AnnotationPoint;
  readonly to: AnnotationPoint;
  readonly points: readonly AnnotationPoint[];
}

export interface AnnotationPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * A mark being moved or resized. Drawing produces a new mark; this edits one
 * that already exists, so it carries the mark it started from and the pointer
 * offset at grab time — without the offset a drag snaps the mark's corner to
 * the cursor on the first move.
 */
export interface AnnotationDrag {
  readonly markId: string;
  readonly mode: "move" | "resize";
  readonly corner?: "tl" | "tr" | "bl" | "br";
  readonly origin: AnnotationPoint;
  readonly startRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

const internalDrag$ = state<AnnotationDrag | null>(null);
const internalZoom$ = state(1);
const internalStroke$ = state<AnnotationStroke | null>(null);
const internalSurface$ = state<HTMLElement | null>(null);

export const annotationStroke$ = computed((get) => {
  return get(internalStroke$);
});

export const annotationSurface$ = computed((get) => {
  return get(internalSurface$);
});

export const annotationDrag$ = computed((get) => {
  return get(internalDrag$);
});

export const annotationZoom$ = computed((get) => {
  return get(internalZoom$);
});

export const setAnnotationDrag$ = command(
  ({ set }, drag: AnnotationDrag | null) => {
    set(internalDrag$, drag);
  },
);

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;

export const zoomAnnotation$ = command(({ get, set }, direction: 1 | -1) => {
  const next = get(internalZoom$) + direction * ZOOM_STEP;
  set(internalZoom$, Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)));
});

export const resetAnnotationZoom$ = command(({ set }) => {
  set(internalZoom$, ZOOM_MIN);
});

export const setAnnotationStroke$ = command(
  ({ set }, stroke: AnnotationStroke | null) => {
    set(internalStroke$, stroke);
  },
);

export const bindAnnotationSurface$ = onRef<HTMLElement>(
  command(({ set }, element: HTMLElement, signal: AbortSignal) => {
    set(internalSurface$, element);
    signal.addEventListener(
      "abort",
      () => {
        set(internalSurface$, null);
      },
      { once: true },
    );
  }),
);

const internalSession$ = state<AnnotationSession | null>(null);
const internalTool$ = state<AnnotationTool>("box");
const internalInk$ = state<AnnotationInk>(DEFAULT_ANNOTATION_INK);
const internalSelectedMarkId$ = state<string | null>(null);

export const annotationSessionTarget$ = computed((get) => {
  return get(internalSession$)?.target ?? null;
});

export const annotationSessionActive$ = computed((get) => {
  return get(internalSession$) !== null;
});

export const annotationDraft$ = computed((get) => {
  return get(internalSession$)?.present ?? emptyAnnotation();
});

export const annotationTool$ = computed((get) => {
  return get(internalTool$);
});

export const annotationInk$ = computed((get) => {
  return get(internalInk$);
});

export const annotationSelectedMarkId$ = computed((get) => {
  return get(internalSelectedMarkId$);
});

export const annotationCanUndo$ = computed((get) => {
  return (get(internalSession$)?.past.length ?? 0) > 0;
});

export const annotationCanRedo$ = computed((get) => {
  return (get(internalSession$)?.future.length ?? 0) > 0;
});

export const openAnnotationEditor$ = command(
  ({ set }, target: AnnotationTarget) => {
    set(internalSession$, {
      target,
      past: [],
      present: target.annotation ?? emptyAnnotation(),
      future: [],
    });
    set(internalTool$, "box");
    set(internalZoom$, 1);
    set(internalInk$, DEFAULT_ANNOTATION_INK);
    set(internalSelectedMarkId$, null);
  },
);

export const closeAnnotationEditor$ = command(({ set }) => {
  set(internalSession$, null);
  set(internalSelectedMarkId$, null);
  set(internalStroke$, null);
  set(internalDrag$, null);
  set(internalZoom$, 1);
});

export const setAnnotationTool$ = command(({ set }, tool: AnnotationTool) => {
  set(internalTool$, tool);
  // Picking a drawing tool is a statement about the next mark, not the one
  // currently selected, so the selection drops with its handles.
  set(internalSelectedMarkId$, null);
});

export const setAnnotationInk$ = command(({ get, set }, ink: AnnotationInk) => {
  set(internalInk$, ink);

  // Recolouring the active mark is what makes the swatch feel like a property
  // of the selection rather than a mode for the next stroke.
  const selectedId = get(internalSelectedMarkId$);
  if (selectedId === null) {
    return;
  }
  set(pushAnnotation$, (current): ImageAnnotation => {
    return {
      ...current,
      marks: current.marks.map((mark) => {
        if (mark.id !== selectedId || mark.shape === "highlight") {
          return mark;
        }
        if (mark.shape === "redact") {
          return mark;
        }
        return { ...mark, ink };
      }),
    };
  });
});

export const selectAnnotationMark$ = command(({ set }, id: string | null) => {
  set(internalSelectedMarkId$, id);
});

/** Every mutation goes through here, so undo never has to be implemented twice. */
export const pushAnnotation$ = command(
  (
    { get, set },
    update: (current: ImageAnnotation) => ImageAnnotation,
  ): void => {
    const session = get(internalSession$);
    if (!session) {
      return;
    }
    const next = update(session.present);
    set(internalSession$, {
      target: session.target,
      past: [...session.past, session.present],
      present: next,
      future: [],
    });
  },
);

export const addAnnotationMark$ = command(
  ({ set }, mark: ImageAnnotationMark) => {
    set(pushAnnotation$, (current) => {
      return { ...current, marks: [...current.marks, mark] };
    });
    set(internalSelectedMarkId$, mark.id);
  },
);

export const removeAnnotationMark$ = command(({ get, set }, id: string) => {
  set(pushAnnotation$, (current) => {
    return {
      ...current,
      marks: current.marks.filter((mark) => {
        return mark.id !== id;
      }),
    };
  });
  if (get(internalSelectedMarkId$) === id) {
    set(internalSelectedMarkId$, null);
  }
});

/** Deletes whatever is selected. Bound to Delete/Backspace in the editor. */
export const removeSelectedAnnotationMark$ = command(({ get, set }) => {
  const id = get(internalSelectedMarkId$);
  if (id === null) {
    return;
  }
  set(removeAnnotationMark$, id);
});

export const moveAnnotationMarkRect$ = command(
  (
    { set },
    id: string,
    rect: { x: number; y: number; width: number; height: number },
  ) => {
    set(pushAnnotation$, (current) => {
      return {
        ...current,
        marks: current.marks.map((mark) => {
          if (mark.id !== id) {
            return mark;
          }
          if (
            mark.shape === "box" ||
            mark.shape === "redact" ||
            mark.shape === "highlight"
          ) {
            return { ...mark, rect };
          }
          if (mark.shape === "text") {
            return { ...mark, at: { x: rect.x, y: rect.y } };
          }
          return mark;
        }),
      };
    });
  },
);

export const setAnnotationMarkNote$ = command(
  ({ set }, id: string, note: string) => {
    set(pushAnnotation$, (current) => {
      return {
        ...current,
        marks: current.marks.map((mark) => {
          if (mark.id !== id || mark.shape === "redact") {
            return mark;
          }
          if (mark.shape === "text") {
            return { ...mark, text: note };
          }
          return { ...mark, note };
        }),
      };
    });
  },
);

export const undoAnnotation$ = command(({ get, set }) => {
  const session = get(internalSession$);
  const previous = session?.past.at(-1);
  if (!session || previous === undefined) {
    return;
  }
  set(internalSession$, {
    target: session.target,
    past: session.past.slice(0, -1),
    present: previous,
    future: [session.present, ...session.future],
  });
  set(internalSelectedMarkId$, null);
});

export const redoAnnotation$ = command(({ get, set }) => {
  const session = get(internalSession$);
  const next = session?.future[0];
  if (!session || next === undefined) {
    return;
  }
  set(internalSession$, {
    target: session.target,
    past: [...session.past, session.present],
    present: next,
    future: session.future.slice(1),
  });
  set(internalSelectedMarkId$, null);
});

/**
 * Hands the marks back to whoever owns the attachment and closes the editor.
 * An annotation with nothing in it commits as `null` rather than as an empty
 * object, so a draft that was merely opened does not start looking annotated.
 */
export const commitAnnotation$ = command(({ get, set }) => {
  const session = get(internalSession$);
  if (!session) {
    return;
  }
  session.target.commit(
    isAnnotationMeaningful(session.present) ? session.present : null,
  );
  set(closeAnnotationEditor$);
});
