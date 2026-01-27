import { command } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "../react-router";
import { SettingsPage } from "../../views/settings-page/settings-page";

/**
 * Setup the settings page.
 */
export const setupSettingsPage$ = command(({ set }) => {
  set(updatePage$, createElement(SettingsPage));
});
