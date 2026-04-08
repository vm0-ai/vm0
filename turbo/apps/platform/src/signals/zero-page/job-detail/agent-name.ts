import { command, computed, state } from "ccstate";
import { search } from "../../location.ts";

// ---------------------------------------------------------------------------
// Agent name — set when navigating to a subagent detail page
// ---------------------------------------------------------------------------

const internalAgentName$ = state<string | null>(null);
export const setZeroJobAgentName$ = command(({ set }, name: string | null) => {
  set(internalAgentName$, name);
});

/** Read-only access to the current agent name (used by detail & permissions). */
export const agentName$ = computed((get) => {
  return get(internalAgentName$);
});

// ---------------------------------------------------------------------------
// Active tab
// ---------------------------------------------------------------------------

function isValidTab(tab: string): boolean {
  return (
    tab === "authorization" ||
    tab === "schedule" ||
    tab === "profile" ||
    tab === "instructions"
  );
}

function getInitialTab(): string {
  const params = new URLSearchParams(search());
  const tab = params.get("tab") ?? "";
  return isValidTab(tab) ? tab : "authorization";
}

const internalActiveTab$ = state("authorization");

export const zeroJobActiveTab$ = computed((get) => {
  return get(internalActiveTab$);
});

export const setZeroJobActiveTab$ = command(({ set }, tab: string) => {
  set(internalActiveTab$, tab);
  const url = new URL(location.href);
  if (tab === "authorization") {
    url.searchParams.delete("tab");
  } else {
    url.searchParams.set("tab", tab);
  }
  history.replaceState(null, "", url.toString());
});

/** Reset active tab to the value derived from the current URL. */
export const resetActiveTab$ = command(({ set }) => {
  set(internalActiveTab$, getInitialTab());
});
