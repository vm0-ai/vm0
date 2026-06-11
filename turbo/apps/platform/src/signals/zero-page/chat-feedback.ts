import { state, computed, command } from "ccstate";
import { writeToClipboard } from "./clipboard.ts";

// Assistant message bubbles carry this class in the chat thread. Text selected
// inside one of them is what we offer feedback on.
const ASSISTANT_BUBBLE_SELECTOR = ".zero-chat-bubble-assistant";

export interface FeedbackSelectionRect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface FeedbackSelection {
  readonly text: string;
  readonly rect: FeedbackSelectionRect;
}

// A passage the user has selected together with the note they attached to it.
export interface FeedbackComment {
  readonly id: number;
  readonly quote: string;
  readonly note: string;
}

// The passage currently being commented on, before it is added to the list.
interface FeedbackDraft {
  readonly quote: string;
  readonly note: string;
}

const feedbackSelection$ = state<FeedbackSelection | null>(null);
const feedbackActive$ = state<boolean>(false);
const feedbackComments$ = state<readonly FeedbackComment[]>([]);
const feedbackDraft$ = state<FeedbackDraft | null>(null);
const feedbackEditingId$ = state<number | null>(null);
const feedbackExpanded$ = state<boolean>(false);
const feedbackNextId$ = state<number>(1);
const feedbackCopied$ = state<boolean>(false);
const feedbackCopiedTimerId$ = state<number | null>(null);

export const feedbackSelectionValue$ = computed((get) => {
  return get(feedbackSelection$);
});

export const feedbackActiveValue$ = computed((get) => {
  return get(feedbackActive$);
});

export const feedbackCommentsValue$ = computed((get) => {
  return get(feedbackComments$);
});

export const feedbackDraftValue$ = computed((get) => {
  return get(feedbackDraft$);
});

export const feedbackEditingIdValue$ = computed((get) => {
  return get(feedbackEditingId$);
});

export const feedbackExpandedValue$ = computed((get) => {
  return get(feedbackExpanded$);
});

export const feedbackCopiedValue$ = computed((get) => {
  return get(feedbackCopied$);
});

// What "Send" will dispatch: every committed comment, plus the draft when it
// carries a not-yet-added note. While editing, the draft mirrors a comment that
// is still in the list, so it is not counted twice.
export const feedbackSendCountValue$ = computed((get) => {
  const committed = get(feedbackComments$).length;
  const draft = get(feedbackDraft$);
  const editing = get(feedbackEditingId$) !== null;
  const draftHasNote = (draft?.note.trim().length ?? 0) > 0;
  return committed + (!editing && draftHasNote ? 1 : 0);
});

function resolveSelectionBubble(range: Range): Element | null {
  const node = range.commonAncestorContainer;
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest(ASSISTANT_BUBBLE_SELECTOR) ?? null;
}

// Read the live document selection when it sits inside an assistant message.
function readAssistantSelection(): { text: string; range: Range } | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }
  const text = selection.toString().trim();
  if (!text) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!resolveSelectionBubble(range)) {
    return null;
  }
  return { text, range };
}

// Compose every comment into a single follow-up turn, each passage quoted above
// the note that belongs to it.
function formatFeedbackPrompt(comments: readonly FeedbackComment[]): string {
  const blocks = comments.map((comment) => {
    const quoted = comment.quote
      .split("\n")
      .map((line) => {
        return `> ${line}`;
      })
      .join("\n");
    return `${quoted}\n\n${comment.note}`;
  });
  const intro =
    comments.length === 1
      ? "Feedback on this part of your reply:"
      : `Feedback on ${comments.length} parts of your reply:`;
  return `${intro}\n\n${blocks.join("\n\n---\n\n")}`;
}

function withCommittedDraft(args: {
  readonly comments: readonly FeedbackComment[];
  readonly draft: FeedbackDraft | null;
  readonly editingId: number | null;
  readonly nextId: number;
}): readonly FeedbackComment[] {
  const draft = args.draft;
  if (!draft || draft.note.trim().length === 0) {
    return args.comments;
  }
  const note = draft.note.trim();
  if (args.editingId !== null) {
    return args.comments.map((comment) => {
      return comment.id === args.editingId
        ? { ...comment, quote: draft.quote, note }
        : comment;
    });
  }
  return [
    ...args.comments,
    {
      id: args.nextId,
      quote: draft.quote,
      note,
    },
  ];
}

// Commit the draft: update the comment being edited in place, or append a new
// one. A blank note is a no-op so empty cards never appear.
const commitDraft$ = command(({ get, set }) => {
  const draft = get(feedbackDraft$);
  if (!draft || draft.note.trim().length === 0) {
    return;
  }
  const editingId = get(feedbackEditingId$);
  const nextId = get(feedbackNextId$);
  if (editingId === null) {
    set(feedbackNextId$, nextId + 1);
  }
  set(
    feedbackComments$,
    withCommittedDraft({
      comments: get(feedbackComments$),
      draft,
      editingId,
      nextId,
    }),
  );
  set(feedbackDraft$, null);
  set(feedbackEditingId$, null);
});

// Watch the document selection and drive the floating toolbar. The toolbar
// shows whether or not the tray is open — selecting another passage and
// clicking "Provide feedback" again is how a further comment is added.
export const captureFeedbackSelection$ = command(({ get, set }) => {
  const found = readAssistantSelection();
  if (!found) {
    if (get(feedbackSelection$) !== null) {
      set(feedbackSelection$, null);
    }
    return;
  }
  const rect = found.range.getBoundingClientRect();
  set(feedbackSelection$, {
    text: found.text,
    rect: {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    },
  });
});

// "Provide feedback" on a passage. When the tray is already open, commit the
// in-progress note first (so nothing is lost) and make this passage the new
// draft; otherwise open the tray seeded with it.
export const startFeedback$ = command(({ get, set }) => {
  const selection = get(feedbackSelection$);
  if (!selection) {
    return;
  }
  if (get(feedbackActive$)) {
    set(commitDraft$);
  }
  set(feedbackActive$, true);
  set(feedbackDraft$, { quote: selection.text, note: "" });
  set(feedbackEditingId$, null);
  set(feedbackSelection$, null);
});

export const setFeedbackDraftNote$ = command(({ get, set }, note: string) => {
  const draft = get(feedbackDraft$);
  if (!draft) {
    return;
  }
  set(feedbackDraft$, { ...draft, note });
});

export const toggleFeedbackExpanded$ = command(({ get, set }) => {
  set(feedbackExpanded$, !get(feedbackExpanded$));
});

export const editFeedbackComment$ = command(({ get, set }, id: number) => {
  set(commitDraft$);
  const comment = get(feedbackComments$).find((item) => {
    return item.id === id;
  });
  if (!comment) {
    return;
  }
  set(feedbackDraft$, { quote: comment.quote, note: comment.note });
  set(feedbackEditingId$, id);
});

export const removeFeedbackComment$ = command(({ get, set }, id: number) => {
  set(
    feedbackComments$,
    get(feedbackComments$).filter((item) => {
      return item.id !== id;
    }),
  );
  if (get(feedbackEditingId$) === id) {
    set(feedbackDraft$, null);
    set(feedbackEditingId$, null);
  }
});

// Flush a non-empty draft, then compose every comment into one prompt. Returns
// null when there is nothing to send.
export const submitFeedback$ = command(({ get, set }): string | null => {
  const comments = withCommittedDraft({
    comments: get(feedbackComments$),
    draft: get(feedbackDraft$),
    editingId: get(feedbackEditingId$),
    nextId: get(feedbackNextId$),
  });
  set(commitDraft$);
  if (comments.length === 0) {
    return null;
  }
  return formatFeedbackPrompt(comments);
});

export const dismissFeedbackSelection$ = command(({ get, set }) => {
  const timerId = get(feedbackCopiedTimerId$);
  if (timerId !== null) {
    window.clearTimeout(timerId);
    set(feedbackCopiedTimerId$, null);
  }
  set(feedbackSelection$, null);
  set(feedbackCopied$, false);
});

export const dismissFeedback$ = command(({ get, set }) => {
  const timerId = get(feedbackCopiedTimerId$);
  if (timerId !== null) {
    window.clearTimeout(timerId);
    set(feedbackCopiedTimerId$, null);
  }
  set(feedbackSelection$, null);
  set(feedbackActive$, false);
  set(feedbackComments$, []);
  set(feedbackDraft$, null);
  set(feedbackEditingId$, null);
  set(feedbackExpanded$, false);
  set(feedbackCopied$, false);
});

// Scrolling detaches the toolbar from its passage, so hide it. The docked tray
// is pinned above the composer, not to the selection, so it stays put.
export const dismissFeedbackOnScroll$ = command(({ get, set }) => {
  if (get(feedbackSelection$) === null) {
    return;
  }
  set(feedbackSelection$, null);
});

export const copyFeedbackSelection$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const selection = get(feedbackSelection$);
    if (!selection) {
      return;
    }
    const ok = await writeToClipboard(selection.text);
    signal.throwIfAborted();
    if (!ok) {
      return;
    }
    const existingTimerId = get(feedbackCopiedTimerId$);
    if (existingTimerId !== null) {
      window.clearTimeout(existingTimerId);
    }
    set(feedbackCopied$, true);
    const timerId = window.setTimeout(() => {
      set(feedbackCopied$, false);
      set(feedbackCopiedTimerId$, null);
    }, 1500);
    set(feedbackCopiedTimerId$, timerId);
  },
);
