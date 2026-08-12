import { command, computed, state, type Command, type Computed } from "ccstate";

export interface FeedbackSource {
  readonly type: "mail";
  readonly id: string;
  readonly status: "draft" | "sent";
  readonly sentId?: string;
}

export interface FeedbackRange {
  /** UTF-16 code-unit offset, compatible with JavaScript String.slice. */
  readonly start: number;
  /** Exclusive UTF-16 code-unit offset. */
  readonly end: number;
}

export interface FeedbackInput {
  readonly quote: string;
  readonly eventId?: string;
  readonly range?: FeedbackRange;
  readonly source?: FeedbackSource;
  readonly sourceRange?: Range;
}

// A quoted passage together with the note the user is writing about it. Every
// fragment is a peer: there is no separate "draft" — each row owns its note and
// edits it in place, so the tray reads as one continuous stack of comments.
export interface FeedbackItem {
  readonly id: number;
  readonly quote: string;
  readonly note: string;
  readonly eventId?: string;
  readonly range?: FeedbackRange;
  readonly source?: FeedbackSource;
}

export interface ComposerFeedbackSignals {
  readonly items$: Computed<readonly FeedbackItem[]>;
  readonly active$: Computed<boolean>;
  readonly add$: Command<number, [FeedbackInput]>;
  readonly remove$: Command<void, [number]>;
}

interface FeedbackEditorAdapter {
  insertItem(item: FeedbackItem): void;
  removeItem(id: number): void;
}

// Internal model shared by the Composer editor and the thread interaction
// that creates feedback. Only `signals` is exposed on ComposerSignals.
export interface ComposerFeedbackModel {
  readonly signals: ComposerFeedbackSignals;
  readonly items$: Computed<readonly FeedbackItem[]>;
  readonly active$: Computed<boolean>;
  readonly replaceFromEditor$: Command<void, [readonly FeedbackItem[]]>;
  connectEditor(editor: FeedbackEditorAdapter): void;
}

const FEEDBACK_HIGHLIGHT_NAME = "zero-feedback";
const feedbackRangesByScope$ = state<
  ReadonlyMap<string, ReadonlyMap<number, Range>>
>(new Map());

function highlightRegistry(): HighlightRegistry | null {
  if (
    typeof CSS === "undefined" ||
    typeof Highlight === "undefined" ||
    !CSS.highlights
  ) {
    return null;
  }
  return CSS.highlights;
}

function applyFeedbackHighlight(
  feedbackRangesByScope: ReadonlyMap<string, ReadonlyMap<number, Range>>,
): void {
  const registry = highlightRegistry();
  if (!registry) {
    return;
  }
  const activeRanges = Array.from(feedbackRangesByScope.values()).flatMap(
    (ranges) => {
      return Array.from(ranges.values());
    },
  );
  if (activeRanges.length === 0) {
    registry.delete(FEEDBACK_HIGHLIGHT_NAME);
    return;
  }
  registry.set(FEEDBACK_HIGHLIGHT_NAME, new Highlight(...activeRanges));
}

const setFeedbackHighlights$ = command(
  ({ get, set }, scope: string, ranges: ReadonlyMap<number, Range>) => {
    const rangesByScope = new Map(get(feedbackRangesByScope$));
    if (ranges.size === 0) {
      rangesByScope.delete(scope);
    } else {
      rangesByScope.set(scope, ranges);
    }
    set(feedbackRangesByScope$, rangesByScope);
    applyFeedbackHighlight(rangesByScope);
  },
);

export const clearComposerFeedbackHighlights$ = command(
  ({ set }, scope: string): void => {
    set(setFeedbackHighlights$, scope, new Map());
  },
);

export function createComposerFeedbackModel(
  highlightScope?: string,
): ComposerFeedbackModel {
  const itemsState$ = state<readonly FeedbackItem[]>([]);
  const nextIdState$ = state(1);
  const sourceRanges$ = state<ReadonlyMap<number, Range>>(new Map());
  let editor: FeedbackEditorAdapter = {
    insertItem() {},
    removeItem() {},
  };
  const items$ = computed((get) => {
    return get(itemsState$);
  });
  const active$ = computed((get) => {
    return get(itemsState$).length > 0;
  });
  const updateSourceRanges$ = command(
    (
      { get, set },
      update: (current: ReadonlyMap<number, Range>) => Map<number, Range>,
    ): void => {
      const next = update(get(sourceRanges$));
      set(sourceRanges$, next);
      if (highlightScope !== undefined) {
        set(setFeedbackHighlights$, highlightScope, next);
      }
    },
  );
  const replaceFromEditor$ = command(
    ({ get, set }, items: readonly FeedbackItem[]) => {
      const retainedIds = new Set(
        items.map((item) => {
          return item.id;
        }),
      );
      set(updateSourceRanges$, (ranges) => {
        return new Map(
          Array.from(ranges).filter(([id]) => {
            return retainedIds.has(id);
          }),
        );
      });
      set(itemsState$, items);
      set(
        nextIdState$,
        items.reduce((nextId, item) => {
          return Math.max(nextId, item.id + 1);
        }, get(nextIdState$)),
      );
    },
  );
  const add$ = command(({ get, set }, input: FeedbackInput): number => {
    const id = get(nextIdState$);
    const item: FeedbackItem = {
      id,
      quote: input.quote,
      note: "",
      ...(input.eventId !== undefined && input.range !== undefined
        ? { eventId: input.eventId, range: input.range }
        : {}),
      ...(input.source ? { source: input.source } : {}),
    };
    set(nextIdState$, id + 1);
    set(itemsState$, (items) => {
      return [...items, item];
    });
    const sourceRange = input.sourceRange;
    if (sourceRange !== undefined) {
      set(updateSourceRanges$, (ranges) => {
        const next = new Map(ranges);
        next.set(id, sourceRange);
        return next;
      });
    }
    editor.insertItem(item);
    return id;
  });
  const remove$ = command(({ get, set }, id: number) => {
    set(updateSourceRanges$, (ranges) => {
      const next = new Map(ranges);
      next.delete(id);
      return next;
    });
    set(
      itemsState$,
      get(itemsState$).filter((item) => {
        return item.id !== id;
      }),
    );
    editor.removeItem(id);
  });

  return {
    signals: { items$, active$, add$, remove$ },
    items$,
    active$,
    replaceFromEditor$,
    connectEditor(nextEditor) {
      editor = nextEditor;
    },
  };
}

// Compose every noted fragment into a single follow-up turn, each passage
// quoted above the note that belongs to it.
export function formatFeedbackPrompt(
  items: readonly Pick<FeedbackItem, "quote" | "note" | "source">[],
): string {
  const firstMailSource = items[0]?.source;
  const commonMailSource =
    firstMailSource !== undefined &&
    items.every((item) => {
      return (
        item.source?.type === "mail" &&
        item.source.id === firstMailSource.id &&
        item.source.status === firstMailSource.status &&
        item.source.sentId === firstMailSource.sentId
      );
    })
      ? firstMailSource
      : null;
  const hasSourceContext = items.some((item) => {
    return item.source !== undefined;
  });
  const mailSourceLabel = (source: FeedbackSource) => {
    return source.status === "draft"
      ? `an email draft (mail draft ID: ${source.id})`
      : `a sent email (mail ID: ${source.id}${source.sentId ? `, sent ID: ${source.sentId}` : ""})`;
  };
  const blocks = items.map((item) => {
    const quoted = item.quote
      .split("\n")
      .map((line) => {
        return `> ${line}`;
      })
      .join("\n");
    const source =
      commonMailSource === null && item.source?.type === "mail"
        ? `Source: ${mailSourceLabel(item.source)}\n\n`
        : "";
    return `${source}${quoted}\n\n${item.note.trim()}`;
  });
  const intro = commonMailSource
    ? items.length === 1
      ? `Feedback on this part of ${mailSourceLabel(commonMailSource)}:`
      : `Feedback on ${items.length} parts of ${mailSourceLabel(commonMailSource)}:`
    : hasSourceContext
      ? `Feedback on ${items.length} selected ${items.length === 1 ? "passage" : "passages"}:`
      : items.length === 1
        ? "Feedback on this part of your reply:"
        : `Feedback on ${items.length} parts of your reply:`;
  return `${intro}\n\n${blocks.join("\n\n---\n\n")}`;
}
