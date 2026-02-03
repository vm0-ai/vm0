import { command } from "ccstate";
import { createElement } from "react";
import { LogsPage } from "../../views/logs-page/logs-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { initLogs$ } from "./logs-signals.ts";

export const setupLogsPage$ = command(({ set }, signal: AbortSignal) => {
  set(updatePage$, createElement(LogsPage));

  set(initLogs$, signal);
});
