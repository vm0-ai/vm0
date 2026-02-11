import { command } from "ccstate";
import { createElement } from "react";
import { LogDetailPage } from "../../views/logs-page/log-detail/log-detail.tsx";
import { updatePage$ } from "../react-router.ts";
import { detach, Reason } from "../utils.ts";

import { setLogDetailSearchTerm$ } from "./log-detail-state.ts";
import { setupEventPolling$ } from "./log-detail-signals.ts";

export const setupLogDetailPage$ = command(({ set }, signal: AbortSignal) => {
  set(updatePage$, createElement(LogDetailPage));

  set(setLogDetailSearchTerm$, "");

  // Start incremental event polling (includes eager initial load).
  // Polling stops automatically on signal abort (route navigation) or
  // when the run reaches a terminal status.
  detach(set(setupEventPolling$, signal), Reason.Daemon);
});
