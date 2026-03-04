import { command } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "../react-router.ts";
import { PreferencesPage } from "../../views/preferences-page/preferences-page.tsx";

export const setupPreferencesPage$ = command(({ set }) => {
  set(updatePage$, createElement(PreferencesPage));
});
