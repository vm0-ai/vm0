import { command, computed } from "ccstate";
import { pathname$, updatePathname$ } from "../route.ts";
import type { ZeroNavId } from "../../views/zero-page/zero-sidebar.tsx";

function isValidTab(tab: string): tab is ZeroNavId {
  return (
    tab === "chat" ||
    tab === "meet" ||
    tab === "schedule" ||
    tab === "job" ||
    tab === "activity" ||
    tab === "works" ||
    tab === "settings" ||
    tab === "preferences"
  );
}

/**
 * Active zero nav id, derived from the URL path `/zero/:tab`.
 * `/zero`, `/zero/chat`, and `/zero/chat/:sessionId` all resolve to "chat".
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
 * Whether the user is on a chat page — `/zero/chat` or `/zero/chat/:sessionId`.
 */
export const zeroInChat$ = computed((get): boolean => {
  const path = get(pathname$);
  return /^\/zero\/chat(\/|$)/.test(path);
});

/**
 * Session ID extracted from `/zero/chat/:sessionId`.
 * Returns null when on `/zero` or `/zero/chat` (no active session).
 */
export const zeroSessionId$ = computed((get): string | null => {
  const path = get(pathname$);
  const match = /^\/zero\/chat\/([^/]+)$/.exec(path);
  return match ? match[1] : null;
});

/**
 * Navigate to a zero tab — updates the URL path to `/zero/:tab`.
 * "chat" maps to `/zero` (the default, no suffix needed).
 */
export const setZeroActiveId$ = command(({ set }, id: ZeroNavId) => {
  const newPath = id === "chat" ? "/zero" : `/zero/${id}`;
  set(updatePathname$, newPath);
});

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

/**
 * Navigate back from a chat session to the chat home — `/zero`.
 */
export const navigateFromZeroSession$ = command(({ set }) => {
  set(updatePathname$, "/zero");
});
