import { command } from "ccstate";
import { createElement } from "react";
import { LogsPage } from "../../views/logs-page/logs-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { seedCursorHistory$ } from "./logs-signals.ts";

export const setupLogsPage$ = command(({ set }) => {
  set(updatePage$, createElement(LogsPage));
  set(seedCursorHistory$);
});
