import { command } from "ccstate";
import { createElement } from "react";
import { LogsPage } from "../../views/logs-page/logs-page.tsx";
import { updatePage$ } from "../react-router.ts";

export const setupLogsPage$ = command(({ set }, signal: AbortSignal) => {
  signal.throwIfAborted();
  set(updatePage$, createElement(LogsPage));
});
