import { command } from "ccstate";
import { createElement } from "react";
import { FeatureSwitchKey } from "@vm0/core";
import { updatePage$ } from "../react-router";
import { SettingsPage } from "../../views/settings-page/settings-page";
import { initSettingsTabs$ } from "./settings-tabs.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { fetchGitHubIntegration$ } from "../integrations-page/github-integration.ts";
import { fetchTelegramIntegration$ } from "../integrations-page/telegram-integration.ts";

/**
 * Setup the settings page.
 */
export const setupSettingsPage$ = command(async ({ set, get }) => {
  set(initSettingsTabs$);
  set(updatePage$, createElement(SettingsPage));
  const features = await get(featureSwitch$);
  await Promise.all([
    features?.[FeatureSwitchKey.GitHubIntegration]
      ? set(fetchGitHubIntegration$)
      : Promise.resolve(),
    features?.[FeatureSwitchKey.TelegramIntegration]
      ? set(fetchTelegramIntegration$)
      : Promise.resolve(),
  ]);
});
