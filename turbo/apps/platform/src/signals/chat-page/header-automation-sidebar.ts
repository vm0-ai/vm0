import { command, computed } from "ccstate";

import {
  replaceSearchParams$,
  searchParams$,
  updateSearchParams$,
} from "../route.ts";
import {
  CHAT_AUTOMATIONS_QUERY_PARAM,
  clearArtifactSidebarParams,
  clearChatAutomationSidebarParams,
} from "../zero-page/right-sidebar-search-params.ts";

export const currentHeaderAutomationThreadId$ = computed((get) => {
  return get(searchParams$).get(CHAT_AUTOMATIONS_QUERY_PARAM);
});

export const openHeaderAutomationSidebar$ = command(
  ({ get, set }, threadId: string) => {
    const params = new URLSearchParams(get(searchParams$));
    params.set(CHAT_AUTOMATIONS_QUERY_PARAM, threadId);
    clearArtifactSidebarParams(params);
    set(updateSearchParams$, params);
  },
);

export const closeHeaderAutomationSidebar$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  if (!params.has(CHAT_AUTOMATIONS_QUERY_PARAM)) {
    return;
  }
  clearChatAutomationSidebarParams(params);
  set(replaceSearchParams$, params);
});
