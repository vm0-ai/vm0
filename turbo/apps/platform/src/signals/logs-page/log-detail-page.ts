import { command, computed, state } from "ccstate";
import { updatePage$ } from "../react-router.ts";
import { pathParams$ } from "../route.ts";

// Internal state for current log ID
const internalCurrentLogId$ = state<string | null>(null);

// Internal state for search term
const internalLogDetailSearchTerm$ = state("");

// Exported computed for read access
export const currentLogId$ = computed((get) => get(internalCurrentLogId$));

// Exported state-like interface for search term (needs read/write)
export const logDetailSearchTerm$ = internalLogDetailSearchTerm$;

export const setupLogDetailPage$ = command(async ({ get, set }) => {
  // Get log ID from route params
  const params = get(pathParams$) as { id?: string } | undefined;
  const logId = params?.id ?? null;

  set(internalCurrentLogId$, logId);

  // Reset search term when navigating to a new log
  set(internalLogDetailSearchTerm$, "");

  // Dynamically import to avoid circular dependency
  const { LogDetailPage } = await import(
    "../../views/logs-page/log-detail-page.tsx"
  );
  const { createElement } = await import("react");

  // Render page
  set(updatePage$, createElement(LogDetailPage));
});
