import { command } from "ccstate";
import { createElement } from "react";
import { LogsPage } from "../../views/logs-page/logs-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { initLogs$ } from "./logs-signals.ts";

export const setupLogsPage$ = command(({ set }, signal: AbortSignal) => {
  // Immediately update page to show LogsPage with skeleton loading
  // This provides instant visual feedback while data is being fetched
  set(updatePage$, createElement(LogsPage));

  // Initialize logs data in background (non-blocking)
  set(initLogs$, signal);
});
