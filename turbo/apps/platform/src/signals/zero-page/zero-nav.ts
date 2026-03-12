import { command, computed } from "ccstate";
import { pathname$, updatePathname$ } from "../route.ts";
import type { ZeroNavId } from "../../views/zero-page/zero-sidebar.tsx";

function isValidTab(tab: string): tab is ZeroNavId {
  return (
    tab === "chat" ||
    tab === "meet" ||
    tab === "schedule" ||
    tab === "job" ||
    tab === "production" ||
    tab === "activity" ||
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
 */
export const setZeroActiveId$ = command(({ set }, id: ZeroNavId) => {
  const newPath = id === "chat" ? "/zero" : `/zero/${id}`;
  set(updatePathname$, newPath);
});
