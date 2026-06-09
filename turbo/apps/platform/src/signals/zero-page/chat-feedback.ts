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

type FeedbackMode = "toolbar" | "composer";

const feedbackSelection$ = state<FeedbackSelection | null>(null);
const feedbackMode$ = state<FeedbackMode>("toolbar");
const feedbackComment$ = state<string>("");
const feedbackCopied$ = state<boolean>(false);
const feedbackCopiedTimerId$ = state<number | null>(null);

export const feedbackSelectionValue$ = computed((get) => {
  return get(feedbackSelection$);
});

export const feedbackModeValue$ = computed((get) => {
  return get(feedbackMode$);
});

export const feedbackCommentValue$ = computed((get) => {
  return get(feedbackComment$);
});

export const feedbackCopiedValue$ = computed((get) => {
  return get(feedbackCopied$);
});

function resolveSelectionBubble(range: Range): Element | null {
  const node = range.commonAncestorContainer;
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest(ASSISTANT_BUBBLE_SELECTOR) ?? null;
}

// Read the live document selection and, when it sits inside an assistant
// message, snapshot its text and viewport rect. Skipped while the composer is
// open — typing there moves the selection and would tear the popover down.
export const captureFeedbackSelection$ = command(({ get, set }) => {
  if (get(feedbackMode$) === "composer") {
    return;
  }
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    if (get(feedbackSelection$) !== null) {
      set(feedbackSelection$, null);
    }
    return;
  }
  const text = selection.toString().trim();
  const range = selection.getRangeAt(0);
  if (!text || !resolveSelectionBubble(range)) {
    if (get(feedbackSelection$) !== null) {
      set(feedbackSelection$, null);
    }
    return;
  }
  const rect = range.getBoundingClientRect();
  set(feedbackSelection$, {
    text,
    rect: {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    },
  });
});

export const setFeedbackComment$ = command(({ set }, value: string) => {
  set(feedbackComment$, value);
});

export const openFeedbackComposer$ = command(({ set }) => {
  set(feedbackMode$, "composer");
});

export const dismissFeedback$ = command(({ get, set }) => {
  const timerId = get(feedbackCopiedTimerId$);
  if (timerId !== null) {
    window.clearTimeout(timerId);
    set(feedbackCopiedTimerId$, null);
  }
  set(feedbackSelection$, null);
  set(feedbackMode$, "toolbar");
  set(feedbackComment$, "");
  set(feedbackCopied$, false);
});

// Scrolling the thread detaches the viewport rect from its passage, so close
// the popover rather than let it drift. No-op when nothing is open.
export const dismissFeedbackOnScroll$ = command(({ get, set }) => {
  if (get(feedbackSelection$) === null) {
    return;
  }
  set(dismissFeedback$);
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
