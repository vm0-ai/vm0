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
  readonly annotations: ImageAnnotation | null;
  readonly commit: (
    annotations: ImageAnnotation | null,
    signal: AbortSignal,
  ) => Promise<void>;
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
  readonly mode: "move" | "resize";
  readonly corner?: AnnotationResizeEdge;
  readonly origin: AnnotationPoint;
  readonly startRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

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
  const y = below > 1 - NOTE_ROOM ? bounds.y - NOTE_GAP - NOTE_ROOM : below;
  return clampNoteBox({ x: bounds.x, y, width });
}

/** Roughly one line of note plus its padding, in normalized units. */
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
  // `noteBox` is only ever read now: nothing writes one since notes stopped
  // being draggable. Drafts saved while they were keep the placement they were
  // given rather than jumping the next time they are opened.
  return { text, ink: mark.ink, box: mark.noteBox ?? defaultNoteBox(mark) };
}

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;

/**
 * What the editor currently has open. `note` is not a second draggable object:
 * it means the mark's sentence is open for editing, which is what clicking the
 * printed label does. Notes used to be moved and resized independently and are
 * now placed by `defaultNoteBox` alone — Tong: *"mark 标注的文字还是不要让用户
 * 随便拖动了 … 标注文字点击也可以进行文本编辑，现在是拖动"*.
 */
interface AnnotationSelection {
  readonly kind: "mark" | "note";
  readonly id: string;
}

function createAnnotationViewportSignals() {
  const drag$ = state<AnnotationDrag | null>(null);
  const zoom$ = state(1);
  const stroke$ = state<AnnotationStroke | null>(null);
  const surface$ = state<HTMLElement | null>(null);
  const annotationStroke$ = computed((get) => {
    return get(stroke$);
  });
  const annotationSurface$ = computed((get) => {
    return get(surface$);
  });
  const annotationDrag$ = computed((get) => {
    return get(drag$);
  });
  const annotationZoom$ = computed((get) => {
    return get(zoom$);
  });
  const setAnnotationDrag$ = command(({ set }, drag: AnnotationDrag | null) => {
    set(drag$, drag);
  });
  const zoomAnnotation$ = command(({ get, set }, direction: 1 | -1) => {
    const next = get(zoom$) + direction * ZOOM_STEP;
    set(zoom$, Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)));
  });
  const resetAnnotationZoom$ = command(({ set }) => {
    set(zoom$, ZOOM_MIN);
  });
  const setAnnotationStroke$ = command(
    ({ set }, stroke: AnnotationStroke | null) => {
      set(stroke$, stroke);
    },
  );
  const bindAnnotationSurface$ = onRef<HTMLElement>(
    command(({ set }, element: HTMLElement, signal: AbortSignal) => {
      set(surface$, element);
      signal.addEventListener(
        "abort",
        () => {
          set(surface$, null);
        },
        { once: true },
      );
    }),
  );
  return {
    internal: { drag$, zoom$, stroke$ },
    signals: {
      annotationStroke$,
      annotationSurface$,
      annotationDrag$,
      annotationZoom$,
      setAnnotationDrag$,
      zoomAnnotation$,
      resetAnnotationZoom$,
      setAnnotationStroke$,
      bindAnnotationSurface$,
    },
  };
}

type AnnotationViewport = ReturnType<typeof createAnnotationViewportSignals>;

function createAnnotationSessionSignals(viewport: AnnotationViewport) {
  const session$ = state<AnnotationSession | null>(null);
  const tool$ = state<AnnotationTool>("box");
  const ink$ = state<AnnotationInk>(DEFAULT_ANNOTATION_INK);
  const selection$ = state<AnnotationSelection | null>(null);
  const annotationSessionTarget$ = computed((get) => {
    return get(session$)?.target ?? null;
  });
  const annotationSessionActive$ = computed((get) => {
    return get(session$) !== null;
  });
  const annotationDraft$ = computed((get) => {
    return get(session$)?.present ?? emptyAnnotation();
  });
  const annotationTool$ = computed((get) => {
    return get(tool$);
  });
  const annotationInk$ = computed((get) => {
    return get(ink$);
  });
  const annotationSelectedMarkId$ = computed((get) => {
    const selection = get(selection$);
    return selection?.kind === "mark" ? selection.id : null;
  });
  const annotationSelectedNoteId$ = computed((get) => {
    const selection = get(selection$);
    return selection?.kind === "note" ? selection.id : null;
  });
  const annotationDirty$ = computed((get) => {
    const session = get(session$);
    return session !== null && session.present !== session.baseline;
  });
  const annotationCanUndo$ = computed((get) => {
    return (get(session$)?.past.length ?? 0) > 0;
  });
  const annotationCanRedo$ = computed((get) => {
    return (get(session$)?.future.length ?? 0) > 0;
  });
  const selectAnnotationNote$ = command(({ set }, id: string | null) => {
    set(selection$, id === null ? null : { kind: "note", id });
  });
  const selectAnnotationMark$ = command(({ set }, id: string | null) => {
    set(selection$, id === null ? null : { kind: "mark", id });
  });
  const setAnnotationTool$ = command(({ set }, tool: AnnotationTool) => {
    set(tool$, tool);
    set(selection$, null);
  });
  const openAnnotationEditor$ = command(({ set }, target: AnnotationTarget) => {
    const opened = target.annotations ?? emptyAnnotation();
    set(session$, {
      target,
      baseline: opened,
      past: [],
      present: opened,
      future: [],
    });
    set(tool$, "box");
    set(viewport.internal.zoom$, ZOOM_MIN);
    set(ink$, DEFAULT_ANNOTATION_INK);
    set(selection$, null);
  });
  const closeAnnotationEditor$ = command(({ set }) => {
    set(session$, null);
    set(selection$, null);
    set(viewport.internal.stroke$, null);
    set(viewport.internal.drag$, null);
    set(viewport.internal.zoom$, ZOOM_MIN);
  });
  return {
    internal: { session$, ink$, selection$ },
    signals: {
      annotationSessionTarget$,
      annotationSessionActive$,
      annotationDraft$,
      annotationTool$,
      annotationInk$,
      annotationSelectedMarkId$,
      annotationSelectedNoteId$,
      annotationDirty$,
      annotationCanUndo$,
      annotationCanRedo$,
      selectAnnotationNote$,
      selectAnnotationMark$,
      setAnnotationTool$,
      openAnnotationEditor$,
      closeAnnotationEditor$,
    },
  };
}

type AnnotationSessionSignals = ReturnType<
  typeof createAnnotationSessionSignals
>;

function createAnnotationHistorySignals(session: AnnotationSessionSignals) {
  const pushAnnotation$ = command(
    (
      { get, set },
      update: (current: ImageAnnotation) => ImageAnnotation,
    ): void => {
      const current = get(session.internal.session$);
      if (!current) {
        return;
      }
      set(session.internal.session$, {
        target: current.target,
        baseline: current.baseline,
        past: [...current.past, current.present],
        present: update(current.present),
        future: [],
      });
    },
  );
  const undoAnnotation$ = command(({ get, set }) => {
    const current = get(session.internal.session$);
    const previous = current?.past.at(-1);
    if (!current || previous === undefined) {
      return;
    }
    set(session.internal.session$, {
      target: current.target,
      baseline: current.baseline,
      past: current.past.slice(0, -1),
      present: previous,
      future: [current.present, ...current.future],
    });
    set(session.internal.selection$, null);
  });
  const redoAnnotation$ = command(({ get, set }) => {
    const current = get(session.internal.session$);
    const next = current?.future[0];
    if (!current || next === undefined) {
      return;
    }
    set(session.internal.session$, {
      target: current.target,
      baseline: current.baseline,
      past: [...current.past, current.present],
      present: next,
      future: current.future.slice(1),
    });
    set(session.internal.selection$, null);
  });
  return { pushAnnotation$, undoAnnotation$, redoAnnotation$ };
}

type AnnotationHistorySignals = ReturnType<
  typeof createAnnotationHistorySignals
>;

function createAnnotationContentSignals(
  session: AnnotationSessionSignals,
  history: AnnotationHistorySignals,
) {
  const setAnnotationInk$ = command(({ get, set }, ink: AnnotationInk) => {
    set(session.internal.ink$, ink);
    const selectedId = get(session.signals.annotationSelectedMarkId$);
    if (selectedId === null) {
      return;
    }
    set(history.pushAnnotation$, (current): ImageAnnotation => {
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
  const setAnnotationMarkNote$ = command(
    ({ set }, id: string, note: string) => {
      set(history.pushAnnotation$, (current) => {
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
            return mark.shape === "text"
              ? { ...mark, text: note }
              : { ...mark, note };
          }),
        };
      });
    },
  );
  return { setAnnotationInk$, setAnnotationMarkNote$ };
}

function createAnnotationGeometrySignals(
  session: AnnotationSessionSignals,
  history: AnnotationHistorySignals,
) {
  const addAnnotationMark$ = command(({ set }, mark: ImageAnnotationMark) => {
    set(history.pushAnnotation$, (current) => {
      return {
        ...current,
        marks: [
          ...current.marks,
          { ...mark, ordinal: nextMarkOrdinal(current.marks) },
        ],
      };
    });
    set(session.internal.selection$, { kind: "mark", id: mark.id });
  });
  const removeAnnotationMark$ = command(({ get, set }, id: string) => {
    set(history.pushAnnotation$, (current) => {
      return {
        ...current,
        marks: current.marks.filter((mark) => {
          return mark.id !== id;
        }),
      };
    });
    if (get(session.internal.selection$)?.id === id) {
      set(session.internal.selection$, null);
    }
  });
  const removeSelectedAnnotationMark$ = command(({ get, set }) => {
    const id = get(session.signals.annotationSelectedMarkId$);
    if (id !== null) {
      set(removeAnnotationMark$, id);
    }
  });
  const moveAnnotationMarkRect$ = command(
    (
      { set },
      id: string,
      rect: { x: number; y: number; width: number; height: number },
    ) => {
      set(history.pushAnnotation$, (current) => {
        return {
          ...current,
          marks: current.marks.map((mark) => {
            if (mark.id !== id) {
              return mark;
            }
            if (mark.shape === "box") {
              return { ...mark, rect };
            }
            return mark.shape === "text"
              ? { ...mark, at: { x: rect.x, y: rect.y } }
              : mark;
          }),
        };
      });
    },
  );
  return {
    addAnnotationMark$,
    removeAnnotationMark$,
    removeSelectedAnnotationMark$,
    moveAnnotationMarkRect$,
  };
}

function createCommitAnnotationSignal(session: AnnotationSessionSignals) {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const current = get(session.internal.session$);
    if (!current) {
      return;
    }
    const annotations = isAnnotationMeaningful(current.present)
      ? current.present
      : null;
    set(session.signals.closeAnnotationEditor$);
    await current.target.commit(annotations, signal);
  });
}

export function createImageAnnotationSignals() {
  const viewport = createAnnotationViewportSignals();
  const session = createAnnotationSessionSignals(viewport);
  const history = createAnnotationHistorySignals(session);
  const content = createAnnotationContentSignals(session, history);
  const geometry = createAnnotationGeometrySignals(session, history);
  return {
    ...viewport.signals,
    ...session.signals,
    ...history,
    ...content,
    ...geometry,
    commitAnnotation$: createCommitAnnotationSignal(session),
  };
}

export type ImageAnnotationSignals = ReturnType<
  typeof createImageAnnotationSignals
>;
