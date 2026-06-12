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

// A quoted passage together with the note the user is writing about it. Every
// fragment is a peer: there is no separate "draft" — each row owns its note and
// edits it in place, so the tray reads as one continuous stack of comments.
export interface FeedbackItem {
  readonly id: number;
  readonly quote: string;
  readonly note: string;
}

const feedbackSelection$ = state<FeedbackSelection | null>(null);
const feedbackItems$ = state<readonly FeedbackItem[]>([]);
const feedbackNextId$ = state<number>(1);
const feedbackCopied$ = state<boolean>(false);
const feedbackCopiedTimerId$ = state<number | null>(null);

export const feedbackSelectionValue$ = computed((get) => {
  return get(feedbackSelection$);
});

export const feedbackItemsValue$ = computed((get) => {
  return get(feedbackItems$);
});

export const feedbackCopiedValue$ = computed((get) => {
  return get(feedbackCopied$);
});

// What "Send" will dispatch: every fragment that carries a non-empty note.
export const feedbackSendCountValue$ = computed((get) => {
  return get(feedbackItems$).filter((item) => {
    return item.note.trim().length > 0;
  }).length;
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

// Compose every noted fragment into a single follow-up turn, each passage
// quoted above the note that belongs to it.
function formatFeedbackPrompt(items: readonly FeedbackItem[]): string {
  const blocks = items.map((item) => {
    const quoted = item.quote
      .split("\n")
      .map((line) => {
        return `> ${line}`;
      })
      .join("\n");
    return `${quoted}\n\n${item.note.trim()}`;
  });
  const intro =
    items.length === 1
      ? "Feedback on this part of your reply:"
      : `Feedback on ${items.length} parts of your reply:`;
  return `${intro}\n\n${blocks.join("\n\n---\n\n")}`;
}

// Watch the document selection and drive the floating toolbar. The toolbar
// shows whether or not the tray is open — selecting another passage and
// clicking "Provide feedback" again is how a further fragment is added.
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

// "Provide feedback" on a passage: append it as a new fragment with an empty
// note. The newest fragment is the one the user just picked, so the view
// focuses its note input.
export const startFeedback$ = command(({ get, set }) => {
  const selection = get(feedbackSelection$);
  if (!selection) {
    return;
  }
  const id = get(feedbackNextId$);
  set(feedbackNextId$, id + 1);
  set(feedbackItems$, [
    ...get(feedbackItems$),
    { id, quote: selection.text, note: "" },
  ]);
  set(feedbackSelection$, null);
});

export const setFeedbackItemNote$ = command(
  ({ get, set }, payload: { id: number; note: string }) => {
    set(
      feedbackItems$,
      get(feedbackItems$).map((item) => {
        return item.id === payload.id ? { ...item, note: payload.note } : item;
      }),
    );
  },
);

export const removeFeedbackItem$ = command(({ get, set }, id: number) => {
  set(
    feedbackItems$,
    get(feedbackItems$).filter((item) => {
      return item.id !== id;
    }),
  );
});

// Compose every noted fragment into one prompt. Returns null when nothing has a
// note yet.
export const submitFeedback$ = command(({ get }): string | null => {
  const noted = get(feedbackItems$).filter((item) => {
    return item.note.trim().length > 0;
  });
  if (noted.length === 0) {
    return null;
  }
  return formatFeedbackPrompt(noted);
});

export const dismissFeedback$ = command(({ get, set }) => {
  const timerId = get(feedbackCopiedTimerId$);
  if (timerId !== null) {
    window.clearTimeout(timerId);
    set(feedbackCopiedTimerId$, null);
  }
  set(feedbackSelection$, null);
  set(feedbackItems$, []);
  set(feedbackCopied$, false);
});

// Dismiss only the floating selection toolbar — the docked tray keeps its
// comments, so clicking away from a fresh selection never wipes earlier notes.
export const dismissFeedbackSelection$ = command(({ get, set }) => {
  const timerId = get(feedbackCopiedTimerId$);
  if (timerId !== null) {
    window.clearTimeout(timerId);
    set(feedbackCopiedTimerId$, null);
  }
  set(feedbackSelection$, null);
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
