import { command } from "ccstate";
import { createElement } from "react";
import { LogsPage } from "../../views/logs-page/logs-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { initLogs$ } from "./logs-signals.ts";
import { setPageSignal$ } from "../page-signal.ts";

export const setupLogsPage$ = command(({ set }, signal: AbortSignal) => {
  signal.throwIfAborted();

  // Set page signal for cleanup
  set(setPageSignal$, signal);

  // Initialize logs (clears and loads first batch)
  set(initLogs$, signal);

  // Render page
  set(updatePage$, createElement(LogsPage));
});
