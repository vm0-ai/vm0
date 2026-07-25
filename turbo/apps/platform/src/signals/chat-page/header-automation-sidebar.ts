import { command, computed, state } from "ccstate";

import {
  replaceSearchParams$,
  searchParams$,
  updateSearchParams$,
} from "../route.ts";
import {
  CHAT_AUTOMATIONS_QUERY_PARAM,
  clearArtifactSidebarParams,
  clearBrowserSessionSidebarParams,
  clearChatAutomationSidebarParams,
  clearMailDraftSidebarParams,
} from "../zero-page/right-sidebar-search-params.ts";

export const currentHeaderAutomationThreadId$ = computed((get) => {
  return get(searchParams$).get(CHAT_AUTOMATIONS_QUERY_PARAM);
});

const editingHeaderWorkflowAutomationId$ = state<string | null>(null);

export const currentEditingHeaderWorkflowAutomationId$ = computed((get) => {
  return get(editingHeaderWorkflowAutomationId$);
});

export const setEditingHeaderWorkflowAutomationId$ = command(
  ({ set }, automationId: string | null) => {
    set(editingHeaderWorkflowAutomationId$, automationId);
  },
);

export const openHeaderAutomationSidebar$ = command(
  ({ get, set }, threadId: string) => {
    const params = new URLSearchParams(get(searchParams$));
    params.set(CHAT_AUTOMATIONS_QUERY_PARAM, threadId);
    clearArtifactSidebarParams(params);
    clearMailDraftSidebarParams(params);
    clearBrowserSessionSidebarParams(params);
    set(updateSearchParams$, params);
  },
);

export const closeHeaderAutomationSidebar$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  if (!params.has(CHAT_AUTOMATIONS_QUERY_PARAM)) {
    return;
  }
  clearChatAutomationSidebarParams(params);
  set(setEditingHeaderWorkflowAutomationId$, null);
  set(replaceSearchParams$, params);
});
