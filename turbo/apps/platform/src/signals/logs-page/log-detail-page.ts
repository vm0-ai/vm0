import { command } from "ccstate";
import { createElement } from "react";
import { LogDetailPage } from "../../views/logs-page/log-detail-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { pathParams$ } from "../route.ts";
import {
  setCurrentLogId$,
  setLogDetailSearchTerm$,
} from "./log-detail-state.ts";

export const setupLogDetailPage$ = command(({ get, set }) => {
  // Get log ID from route params
  const params = get(pathParams$) as { id?: string } | undefined;
  const logId = params?.id ?? null;

  set(setCurrentLogId$, logId);

  // Reset search term when navigating to a new log
  set(setLogDetailSearchTerm$, "");

  // Render page
  set(updatePage$, createElement(LogDetailPage));
});
