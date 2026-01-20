import { command } from "ccstate";
import { createElement } from "react";
import { LogsPage } from "../../views/logs-page/logs-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { setLogs$, loadMore$ } from "./logs-signals.ts";
import { setPageSignal$ } from "../page-signal.ts";

export const setupLogsPage$ = command(async ({ set }, signal: AbortSignal) => {
  signal.throwIfAborted();

  // Set page signal for cleanup
  set(setPageSignal$, signal);

  // Clear any existing logs data (important for filter changes)
  set(setLogs$, []);

  // Load first batch of data
  await set(loadMore$, signal);

  // Render page
  set(updatePage$, createElement(LogsPage));
});
