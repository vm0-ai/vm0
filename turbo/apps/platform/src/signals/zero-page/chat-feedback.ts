import { command, computed, state, type Command, type Computed } from "ccstate";

export interface FeedbackSource {
  readonly type: "mail";
  readonly id: string;
  readonly status: "draft" | "sent";
  readonly sentId?: string;
}

export interface FeedbackInput {
  readonly quote: string;
  readonly source?: FeedbackSource;
}

// A quoted passage together with the note the user is writing about it. Every
// fragment is a peer: there is no separate "draft" — each row owns its note and
// edits it in place, so the tray reads as one continuous stack of comments.
export interface FeedbackItem {
  readonly id: number;
  readonly quote: string;
  readonly note: string;
  readonly source?: FeedbackSource;
}

export interface ComposerFeedbackSignals {
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

export function createComposerFeedbackModel(): ComposerFeedbackModel {
  const itemsState$ = state<readonly FeedbackItem[]>([]);
  const nextIdState$ = state(1);
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
  const replaceFromEditor$ = command(
    ({ get, set }, items: readonly FeedbackItem[]) => {
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
      ...(input.source ? { source: input.source } : {}),
    };
    set(nextIdState$, id + 1);
    set(itemsState$, (items) => {
      return [...items, item];
    });
    editor.insertItem(item);
    return id;
  });
  const remove$ = command(({ get, set }, id: number) => {
    set(
      itemsState$,
      get(itemsState$).filter((item) => {
        return item.id !== id;
      }),
    );
    editor.removeItem(id);
  });

  return {
    signals: { add$, remove$ },
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
