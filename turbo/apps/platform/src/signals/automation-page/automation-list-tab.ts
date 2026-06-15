/**
 * Top-level tab state for the /automations page: Calendar (default) and List.
 * Persisted to the URL via `?tab=` so the view is linkable.
 */
import { command, computed, state } from "ccstate";
import { search, replaceState, pathname } from "../location.ts";

type AutomationListTab = "list" | "calendar";

const DEFAULT_TAB: AutomationListTab = "calendar";

function isValidTab(tab: string): tab is AutomationListTab {
  return tab === "list" || tab === "calendar";
}

function getInitialTab(): AutomationListTab {
  const params = new URLSearchParams(search());
  const tab = params.get("tab") ?? "";
  return isValidTab(tab) ? tab : DEFAULT_TAB;
}

const internalTab$ = state<AutomationListTab>(DEFAULT_TAB);

export const automationListTab$ = computed((get) => {
  return get(internalTab$);
});

export const setAutomationListTab$ = command(
  ({ set }, tab: AutomationListTab) => {
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
export const initAutomationListTab$ = command(({ set }) => {
  set(internalTab$, getInitialTab());
});
