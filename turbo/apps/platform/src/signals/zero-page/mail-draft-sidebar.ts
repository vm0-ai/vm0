import { command, computed } from "ccstate";

import {
  replaceSearchParams$,
  searchParams$,
  updateSearchParams$,
} from "../route.ts";
import {
  MAIL_DRAFT_QUERY_PARAM,
  clearArtifactSidebarParams,
  clearBrowserSessionSidebarParams,
  clearChatAutomationSidebarParams,
  clearMailDraftSidebarParams,
} from "./right-sidebar-search-params.ts";

export const currentMailDraftId$ = computed((get) => {
  return get(searchParams$).get(MAIL_DRAFT_QUERY_PARAM);
});

export const openMailDraftSidebar$ = command(
  ({ get, set }, mailDraftId: string) => {
    const params = new URLSearchParams(get(searchParams$));
    params.set(MAIL_DRAFT_QUERY_PARAM, mailDraftId);
    clearArtifactSidebarParams(params);
    clearChatAutomationSidebarParams(params);
    clearBrowserSessionSidebarParams(params);
    set(updateSearchParams$, params);
  },
);

export const closeMailDraftSidebar$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  if (!params.has(MAIL_DRAFT_QUERY_PARAM)) {
    return;
  }
  clearMailDraftSidebarParams(params);
  set(replaceSearchParams$, params);
});
