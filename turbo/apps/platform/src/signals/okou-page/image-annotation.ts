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
 * The ground a note is printed on. Nearly opaque white rather than a halo: a
 * sentence has to stay readable over a screenshot of anything, including dark
 * UI, and a halo only separates a few pixels of each glyph.
 */
export const NOTE_GROUND = "rgba(255, 255, 255, 0.94)";

/**
 * `highlight`, `crop` and `redact` were dropped, and `select` with them: a
 * mark is clicked directly, so a mode for "not drawing" has nothing left to do,
 * and a tool whose job nobody could name off its icon is not worth a slot. The
 * *shapes* stay in the contract — a draft saved before this change can still
 * carry one, and it has to keep rendering.
 */
export type AnnotationTool = "box" | "arrow" | "pen" | "text";

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
  if (mark.shape === "highlight" || mark.shape === "redact") {
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
 * The number drawn on a mark and quoted back to the agent.
 *
 * Stored on the mark rather than read off its position: deleting one mark must
 * not renumber the others, or every note the user already wrote about "3" now
 * points at a different box. Marks saved before the field existed fall back to
 * their position.
 */
export function markOrdinal(mark: ImageAnnotationMark, index: number): number {
  return mark.ordinal ?? index + 1;
}

/**
 * The lowest number not currently on the image.
 *
 * Deleting the fifth of ten marks leaves a hole, and the next mark drawn fills
 * it instead of becoming eleven. The numbering stays as dense as the marks are
 * without disturbing any mark that is already there.
 */
export function nextMarkOrdinal(marks: readonly ImageAnnotationMark[]): number {
  const taken = new Set(
    marks.map((mark, index) => {
      return markOrdinal(mark, index);
    }),
  );
  let candidate = 1;
  while (taken.has(candidate)) {
    candidate += 1;
  }
  return candidate;
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
    const note = markNote(mark)?.trim();
    const ordinal = markOrdinal(mark, index);
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
  /**
   * The annotation the editor opened on. Undo restores the exact object it
   * pushed, so identity against this is enough to tell whether the session has
   * anything to attach — no structural comparison, and undoing back to the
   * start correctly reads as unchanged again.
   */
  readonly baseline: ImageAnnotation;
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

/** The eight grips on a selected mark: four corners and four edges. */
export const ANNOTATION_RESIZE_EDGES = [
  "tl",
  "tr",
  "bl",
  "br",
  "t",
  "b",
  "l",
  "r",
] as const;

export type AnnotationResizeEdge = (typeof ANNOTATION_RESIZE_EDGES)[number];

/**
 * A mark being moved or resized. Drawing produces a new mark; this edits one
 * that already exists, so it carries the mark it started from and the pointer
 * offset at grab time — without the offset a drag snaps the mark's corner to
 * the cursor on the first move.
 */
export interface AnnotationDrag {
  readonly markId: string;
  readonly mode: "move" | "resize" | "note-move" | "note-resize";
  readonly corner?: AnnotationResizeEdge;
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
/**
 * What is currently held: a mark, or the note label of a mark. One signal
 * rather than two, because the two are mutually exclusive and holding that
 * invariant by hand across every clear site is how a stale grip survives an
 * operation that was supposed to drop the selection.
 */
interface AnnotationSelection {
  readonly kind: "mark" | "note";
  readonly id: string;
}

const internalSelection$ = state<AnnotationSelection | null>(null);

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
  const selection = get(internalSelection$);
  return selection?.kind === "mark" ? selection.id : null;
});

export const annotationSelectedNoteId$ = computed((get) => {
  const selection = get(internalSelection$);
  return selection?.kind === "note" ? selection.id : null;
});

export const selectAnnotationNote$ = command(({ set }, id: string | null) => {
  set(internalSelection$, id === null ? null : { kind: "note", id });
});

export const moveAnnotationNoteBox$ = command(
  ({ set }, id: string, box: { x: number; y: number; width: number }) => {
    set(pushAnnotation$, (current) => {
      return {
        ...current,
        marks: current.marks.map((mark) => {
          if (
            mark.id !== id ||
            mark.shape === "text" ||
            mark.shape === "redact" ||
            mark.shape === "highlight"
          ) {
            return mark;
          }
          return { ...mark, noteBox: clampNoteBox(box) };
        }),
      };
    });
  },
);

/** Whether the session has anything worth attaching. */
export const annotationDirty$ = computed((get) => {
  const session = get(internalSession$);
  return session !== null && session.present !== session.baseline;
});

export const annotationCanUndo$ = computed((get) => {
  return (get(internalSession$)?.past.length ?? 0) > 0;
});

export const annotationCanRedo$ = computed((get) => {
  return (get(internalSession$)?.future.length ?? 0) > 0;
});

export const openAnnotationEditor$ = command(
  ({ set }, target: AnnotationTarget) => {
    const opened = target.annotation ?? emptyAnnotation();
    set(internalSession$, {
      target,
      baseline: opened,
      past: [],
      present: opened,
      future: [],
    });
    set(internalTool$, "box");
    set(internalZoom$, 1);
    set(internalInk$, DEFAULT_ANNOTATION_INK);
    set(internalSelection$, null);
  },
);

export const closeAnnotationEditor$ = command(({ set }) => {
  set(internalSession$, null);
  set(internalSelection$, null);
  set(internalStroke$, null);
  set(internalDrag$, null);
  set(internalZoom$, 1);
});

export const setAnnotationTool$ = command(({ set }, tool: AnnotationTool) => {
  set(internalTool$, tool);
  // Picking a drawing tool is a statement about the next mark, not the one
  // currently selected, so the selection drops with its handles.
  set(internalSelection$, null);
});

export const setAnnotationInk$ = command(({ get, set }, ink: AnnotationInk) => {
  set(internalInk$, ink);

  // Recolouring the active mark is what makes the swatch feel like a property
  // of the selection rather than a mode for the next stroke.
  const selectedId = get(annotationSelectedMarkId$);
  if (selectedId === null) {
    return;
  }
  set(pushAnnotation$, (current): ImageAnnotation => {
    return {
      ...current,
      marks: current.marks.map((mark) => {
        if (
          mark.id !== selectedId ||
          mark.shape === "highlight" ||
          mark.shape === "redact"
        ) {
          return mark;
        }
        return { ...mark, ink };
      }),
    };
  });
});

export const selectAnnotationMark$ = command(({ set }, id: string | null) => {
  set(internalSelection$, id === null ? null : { kind: "mark", id });
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
      baseline: session.baseline,
      past: [...session.past, session.present],
      present: next,
      future: [],
    });
  },
);

export const addAnnotationMark$ = command(
  ({ set }, mark: ImageAnnotationMark) => {
    set(pushAnnotation$, (current) => {
      return {
        ...current,
        marks: [
          ...current.marks,
          { ...mark, ordinal: nextMarkOrdinal(current.marks) },
        ],
      };
    });
    set(internalSelection$, { kind: "mark", id: mark.id });
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
  // The note belongs to the mark, so removing the mark drops either hold.
  if (get(internalSelection$)?.id === id) {
    set(internalSelection$, null);
  }
});

/** Deletes whatever is selected. Bound to Delete/Backspace in the editor. */
export const removeSelectedAnnotationMark$ = command(({ get, set }) => {
  const id = get(annotationSelectedMarkId$);
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
          if (mark.shape === "box") {
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

/** A note narrower than this wraps every other word and reads as a column. */
const MIN_NOTE_WIDTH = 0.18;
const MAX_NOTE_WIDTH = 1;
/** Clear of the mark's own outline and its ordinal pin. */
const NOTE_GAP = 0.015;

/** The box a mark occupies, used to place its note under it. */
export function markBounds(mark: ImageAnnotationMark): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (mark.shape === "arrow") {
    return {
      x: Math.min(mark.from.x, mark.to.x),
      y: Math.min(mark.from.y, mark.to.y),
      width: Math.abs(mark.to.x - mark.from.x),
      height: Math.abs(mark.to.y - mark.from.y),
    };
  }
  if (mark.shape === "pen") {
    const xs = mark.points.map((point) => {
      return point.x;
    });
    const ys = mark.points.map((point) => {
      return point.y;
    });
    const x = Math.min(...xs, 1);
    const y = Math.min(...ys, 1);
    return {
      x,
      y,
      width: Math.max(...xs, 0) - x,
      height: Math.max(...ys, 0) - y,
    };
  }
  if (mark.shape === "text") {
    return { x: mark.at.x, y: mark.at.y, width: 0, height: 0 };
  }
  return mark.rect;
}

/**
 * Where a note lands the first time it is written: directly under its mark and
 * at least as wide, so the sentence reads as belonging to that region without
 * the user having to place it.
 */
export function defaultNoteBox(mark: ImageAnnotationMark): {
  x: number;
  y: number;
  width: number;
} {
  const bounds = markBounds(mark);
  const width = Math.min(
    MAX_NOTE_WIDTH,
    Math.max(MIN_NOTE_WIDTH, bounds.width),
  );
  const below = bounds.y + bounds.height + NOTE_GAP;
  // A mark low in the image has no room under it, and a note printed past the
  // bottom edge is cropped out of the flattened copy — silently, because the
  // text still travels in the prompt. Put it above the mark instead.
  const y = below > 1 - NOTE_ROOM ? bounds.y - NOTE_GAP - NOTE_ROOM : below;
  return clampNoteBox({ x: bounds.x, y, width });
}

/**
 * Roughly one line of note plus its padding, in normalized units. Used to
 * decide whether a note fits below its mark before the text is measured.
 */
const NOTE_ROOM = 0.06;

/** Keeps a note inside the image, so the flatten cannot crop it away. */
export function clampNoteBox(box: { x: number; y: number; width: number }): {
  x: number;
  y: number;
  width: number;
} {
  const width = Math.min(MAX_NOTE_WIDTH, Math.max(MIN_NOTE_WIDTH, box.width));
  return {
    x: Math.min(Math.max(0, box.x), Math.max(0, 1 - width)),
    y: Math.min(Math.max(0, box.y), Math.max(0, 1 - NOTE_ROOM)),
    width,
  };
}

/** The note text of a mark that can carry one drawn on the image. */
export function noteOnImage(mark: ImageAnnotationMark): {
  text: string;
  ink: string;
  box: { x: number; y: number; width: number };
} | null {
  if (
    mark.shape === "text" ||
    mark.shape === "redact" ||
    mark.shape === "highlight"
  ) {
    return null;
  }
  const text = mark.note?.trim();
  if (!text) {
    return null;
  }
  // Every shape that reaches here declares `ink` as required, so the colour is
  // read from the narrowed mark rather than guessed by a caller.
  return { text, ink: mark.ink, box: mark.noteBox ?? defaultNoteBox(mark) };
}

export const setAnnotationMarkNote$ = command(
  ({ set }, id: string, note: string) => {
    set(pushAnnotation$, (current) => {
      return {
        ...current,
        marks: current.marks.map((mark) => {
          if (
            mark.id !== id ||
            mark.shape === "highlight" ||
            mark.shape === "redact"
          ) {
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
    baseline: session.baseline,
    past: session.past.slice(0, -1),
    present: previous,
    future: [session.present, ...session.future],
  });
  set(internalSelection$, null);
});

export const redoAnnotation$ = command(({ get, set }) => {
  const session = get(internalSession$);
  const next = session?.future[0];
  if (!session || next === undefined) {
    return;
  }
  set(internalSession$, {
    target: session.target,
    baseline: session.baseline,
    past: [...session.past, session.present],
    present: next,
    future: session.future.slice(1),
  });
  set(internalSelection$, null);
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
