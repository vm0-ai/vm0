import { command, computed, state } from "ccstate";
import { match } from "path-to-regexp";
import { pathname, search } from "../../location.ts";
import {
  pathParams$,
  replacePathSilently$,
  searchParams$,
} from "../../route.ts";
import { ROUTES } from "../../route-paths.ts";

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
// ---------------------------------------------------------------------------

function isValidTab(tab: string): boolean {
  return (
    tab === "authorization" ||
    tab === "automations" ||
    tab === "workflows" ||
    tab === "profile" ||
    tab === "instructions"
  );
}

function getInitialTab(): string {
  if (
    match(ROUTES.agentWorkflows, { decode: decodeURIComponent })(pathname())
  ) {
    return "workflows";
  }
  const params = new URLSearchParams(search());
  const tab = params.get("tab") ?? "";
  return isValidTab(tab) ? tab : "authorization";
}

const internalActiveTab$ = state("authorization");

export const agentActiveTab$ = computed((get) => {
  return get(internalActiveTab$);
});

export const setAgentActiveTab$ = command(({ get, set }, tab: string) => {
  const nextTab = isValidTab(tab) ? tab : "authorization";
  set(internalActiveTab$, nextTab);

  const params = get(pathParams$) ?? {};
  const agentId = params.agentId;
  if (typeof agentId !== "string") {
    return;
  }

  if (nextTab === "workflows") {
    set(replacePathSilently$, ROUTES.agentWorkflows, { agentId });
    return;
  }

  const nextSearchParams = new URLSearchParams(get(searchParams$));
  if (nextTab === "authorization") {
    nextSearchParams.delete("tab");
  } else {
    nextSearchParams.set("tab", nextTab);
  }
  set(replacePathSilently$, ROUTES.agentDetail, { agentId }, nextSearchParams);
});

/** Reset active tab to the value derived from the current URL. */
export const resetActiveTab$ = command(({ set }) => {
  set(internalActiveTab$, getInitialTab());
});
