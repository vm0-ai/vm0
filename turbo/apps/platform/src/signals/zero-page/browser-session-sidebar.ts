import { command, computed } from "ccstate";

import {
  replaceSearchParams$,
  searchParams$,
  updateSearchParams$,
} from "../route.ts";
import {
  BROWSER_SESSION_QUERY_PARAM,
  clearArtifactSidebarParams,
  clearBrowserSessionSidebarParams,
  clearChatAutomationSidebarParams,
  clearMailDraftSidebarParams,
} from "./right-sidebar-search-params.ts";

export const currentBrowserSessionId$ = computed((get) => {
  return get(searchParams$).get(BROWSER_SESSION_QUERY_PARAM);
});

export const openBrowserSessionSidebar$ = command(
  ({ get, set }, browserId: string) => {
    const params = new URLSearchParams(get(searchParams$));
    params.set(BROWSER_SESSION_QUERY_PARAM, browserId);
    clearArtifactSidebarParams(params);
    clearChatAutomationSidebarParams(params);
    clearMailDraftSidebarParams(params);
    set(updateSearchParams$, params);
  },
);

export const closeBrowserSessionSidebar$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  if (!params.has(BROWSER_SESSION_QUERY_PARAM)) {
    return;
  }
  clearBrowserSessionSidebarParams(params);
  set(replaceSearchParams$, params);
});
