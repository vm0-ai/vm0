import { command, computed, state } from "ccstate";
import { replaceState, search } from "../../location.ts";

// ---------------------------------------------------------------------------
// Agent name — set when navigating to a subagent detail page
// ---------------------------------------------------------------------------

const internalAgentName$ = state<string | null>(null);
export const setAgentName$ = command(({ set }, name: string | null) => {
  set(internalAgentName$, name);
});

/** Read-only access to the current agent name (used by detail & permissions). */
export const agentName$ = computed((get) => {
  return get(internalAgentName$);
});

// ---------------------------------------------------------------------------
// Active tab
//
// `null` is the "index" view used by the mobile-native redesign — no specific
// section selected, render the grouped list of rows. Desktop coerces null to
// "authorization" for tab display so the existing tabs layout is unchanged.
// ---------------------------------------------------------------------------

export type AgentTabKey =
  | "authorization"
  | "schedule"
  | "profile"
  | "instructions";

function isValidTab(tab: string): tab is AgentTabKey {
  return (
    tab === "authorization" ||
    tab === "schedule" ||
    tab === "profile" ||
    tab === "instructions"
  );
}

function getInitialTab(): AgentTabKey | null {
  const params = new URLSearchParams(search());
  const tab = params.get("tab") ?? "";
  return isValidTab(tab) ? tab : null;
}

const internalActiveTab$ = state<AgentTabKey | null>(null);

export const agentActiveTab$ = computed((get) => {
  return get(internalActiveTab$);
});

export const setAgentActiveTab$ = command(
  ({ set }, tab: AgentTabKey | null) => {
    set(internalActiveTab$, tab);
    const url = new URL(location.href);
    if (tab === null) {
      url.searchParams.delete("tab");
    } else {
      url.searchParams.set("tab", tab);
    }
    replaceState(null, "", url.toString());
  },
);

/** Reset active tab to the value derived from the current URL. */
export const resetActiveTab$ = command(({ set }) => {
  set(internalActiveTab$, getInitialTab());
});
