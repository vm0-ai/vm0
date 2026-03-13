import { command, computed, state } from "ccstate";
import { pathname$, updatePathname$ } from "../route.ts";
import type { ZeroNavId } from "../../views/zero-page/zero-sidebar.tsx";

const internalPendingPrompt$ = state<string | null>(null);

/** Read the pending prompt to pre-fill in the chat composer. */
export const pendingChatPrompt$ = computed((get) =>
  get(internalPendingPrompt$),
);

/** Set or clear the pending chat prompt. */
export const setPendingChatPrompt$ = command(
  ({ set }, prompt: string | null) => {
    set(internalPendingPrompt$, prompt);
  },
);

function isValidTab(tab: string): tab is ZeroNavId {
  return (
    tab === "chat" ||
    tab === "meet" ||
    tab === "schedule" ||
    tab === "job" ||
    tab === "production" ||
    tab === "logs" ||
    tab === "works" ||
    tab === "settings" ||
    tab === "account"
  );
}

/**
 * Active zero nav id, derived from the URL path `/zero/:tab`.
 * `/zero` and `/zero/chat` both resolve to "chat".
 */
export const zeroActiveId$ = computed((get): ZeroNavId => {
  const path = get(pathname$);
  const segment = path.replace(/^\/zero\/?/, "").split("/")[0];
  if (segment && isValidTab(segment)) {
    return segment;
  }
  return "chat";
});

/**
 * Navigate to a zero tab — updates the URL path to `/zero/:tab`.
 * "chat" maps to `/zero` (the default, no suffix needed).
 * Pass an optional sub-path for nested routes (e.g. `/zero/chat/1`).
 */
export const setZeroActiveId$ = command(
  ({ set }, id: ZeroNavId, sub?: string) => {
    let newPath = id === "chat" && !sub ? "/zero" : `/zero/${id}`;
    if (sub) {
      newPath += `/${sub}`;
    }
    set(updatePathname$, newPath);
  },
);

/**
 * Sub-path segment under the current tab, e.g. `/zero/activity/:sub`.
 * Returns null when there is no sub-segment.
 */
export const zeroTabSub$ = computed((get): string | null => {
  const path = get(pathname$);
  const parts = path.replace(/^\/zero\/?/, "").split("/");
  return parts[1] || null;
});

/**
 * Navigate to a specific chat session — `/zero/chat/:sessionId`.
 */
export const navigateToZeroSession$ = command(({ set }, sessionId: string) => {
  set(updatePathname$, `/zero/chat/${sessionId}`);
});
