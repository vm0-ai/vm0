import { command, computed, state } from "ccstate";
import { search, replaceState, pathname } from "../location.ts";

type ScheduleDetailTab = "settings" | "instructions" | "history";

const DEFAULT_TAB: ScheduleDetailTab = "settings";

function isValidTab(tab: string): tab is ScheduleDetailTab {
  return tab === "settings" || tab === "instructions" || tab === "history";
}

function getInitialTab(): ScheduleDetailTab {
  const params = new URLSearchParams(search());
  const tab = params.get("tab") ?? "";
  return isValidTab(tab) ? tab : DEFAULT_TAB;
}

const internalTab$ = state<ScheduleDetailTab>(DEFAULT_TAB);

export const scheduleDetailTab$ = computed((get) => {
  return get(internalTab$);
});

export const setScheduleDetailTab$ = command(
  ({ set }, tab: ScheduleDetailTab) => {
    set(internalTab$, tab);
    const url = new URL(pathname() + search(), location.origin);
    if (tab === DEFAULT_TAB) {
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
