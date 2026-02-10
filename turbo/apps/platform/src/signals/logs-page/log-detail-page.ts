import { command } from "ccstate";
import { createElement } from "react";
import { LogDetailPage } from "../../views/logs-page/log-detail/log-detail.tsx";
import { updatePage$ } from "../react-router.ts";

import { setLogDetailSearchTerm$ } from "./log-detail-state.ts";

export const setupLogDetailPage$ = command(({ set }) => {
  set(updatePage$, createElement(LogDetailPage));

  set(setLogDetailSearchTerm$, "");
});
