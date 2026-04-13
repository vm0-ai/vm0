/**
 * Top-level tab state for the /schedules page: List (default), Calendar, and
 * Run History. Persisted to the URL via `?tab=` so the view is linkable.
 */
import { command, computed, state } from "ccstate";
import { search, replaceState, pathname } from "../location.ts";

type ScheduleListTab = "list" | "calendar" | "history";

const DEFAULT_TAB: ScheduleListTab = "list";

function isValidTab(tab: string): tab is ScheduleListTab {
  return tab === "list" || tab === "calendar" || tab === "history";
}

function getInitialTab(): ScheduleListTab {
  const params = new URLSearchParams(search());
  const tab = params.get("tab") ?? "";
  return isValidTab(tab) ? tab : DEFAULT_TAB;
}

const internalTab$ = state<ScheduleListTab>(DEFAULT_TAB);

export const scheduleListTab$ = computed((get) => {
  return get(internalTab$);
});

export const setScheduleListTab$ = command(({ set }, tab: ScheduleListTab) => {
  set(internalTab$, tab);
  const url = new URL(pathname() + search(), location.origin);
  if (tab === DEFAULT_TAB) {
    url.searchParams.delete("tab");
  } else {
    url.searchParams.set("tab", tab);
  }
  replaceState(null, "", url.pathname + url.search);
});

/** Read the initial tab from the URL. Call once on page setup. */
export const initScheduleListTab$ = command(({ set }) => {
  set(internalTab$, getInitialTab());
});
