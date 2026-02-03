import { command } from "ccstate";
import { createElement } from "react";
import { SchedulesPage } from "../../views/schedules-page/schedules-page.tsx";
import { updatePage$ } from "../react-router.ts";

export const setupSchedulesPage$ = command(({ set }) => {
  set(updatePage$, createElement(SchedulesPage));
});
