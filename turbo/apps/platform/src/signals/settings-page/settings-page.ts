import { command } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "../react-router";
import { SettingsPage } from "../../views/settings-page/settings-page";
import { initSettingsTabs$ } from "./settings-tabs.ts";

/**
 * Setup the settings page.
 */
export const setupSettingsPage$ = command(({ set }) => {
  set(initSettingsTabs$);
  set(updatePage$, createElement(SettingsPage));
});
