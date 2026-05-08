import { command, computed, state } from "ccstate";
import { search, replaceState, pathname } from "../location.ts";

// `null` is the mobile-native "index" view — no tab selected, render the
// schedule overview with a grouped list of section rows. Desktop coerces
// null to "settings" for the tab list so the existing layout is unchanged.
export type ScheduleDetailTab = "settings" | "instructions" | "history";

function isValidTab(tab: string): tab is ScheduleDetailTab {
  return tab === "settings" || tab === "instructions" || tab === "history";
}

function getInitialTab(): ScheduleDetailTab | null {
  const params = new URLSearchParams(search());
  const tab = params.get("tab") ?? "";
  return isValidTab(tab) ? tab : null;
}

const internalTab$ = state<ScheduleDetailTab | null>(null);

export const scheduleDetailTab$ = computed((get) => {
  return get(internalTab$);
});

export const setScheduleDetailTab$ = command(
  ({ set }, tab: ScheduleDetailTab | null) => {
    set(internalTab$, tab);
    const url = new URL(pathname() + search(), location.origin);
    if (tab === null) {
      url.searchParams.delete("tab");
    } else {
      url.searchParams.set("tab", tab);
    }
    replaceState(null, "", url.pathname + url.search);
  },
);

/** Read the initial tab from the URL. Call once on page setup. */
export const initScheduleDetailTab$ = command(({ set }) => {
  set(internalTab$, getInitialTab());
});
