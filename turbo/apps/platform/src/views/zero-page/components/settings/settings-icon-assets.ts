import {
  connectorIconAssetUrl,
  isConnectorIconAssetKey,
  type ConnectorIconAssetKey,
} from "@vm0/connectors/static-connector-icons";

import { platformStaticAssetUrl } from "../../../../lib/static-assets.ts";

const SETTINGS_ONLY_ICON_ASSET_PATHS = {
  anthropic:
    "views/zero-page/components/settings/icons/anthropic-3fcfdf761a69.svg",
  azure: "views/zero-page/components/settings/icons/azure-a3fe212c8716.svg",
  bedrock: "views/zero-page/components/settings/icons/bedrock-60e2c52cb4a2.svg",
  chatglm: "views/zero-page/components/settings/icons/chatglm-7e6a9cb772fa.svg",
  "claude-code":
    "views/zero-page/components/settings/icons/claude-code-03a5132e24ca.svg",
  imessage:
    "views/zero-page/components/settings/icons/imessage-5275a5a9cb9a.svg",
  kimi: "views/zero-page/components/settings/icons/kimi-bd6d8b8d5390.svg",
  "local-agent":
    "views/zero-page/components/settings/icons/local-agent-57c613146fc9.svg",
  "local-browser":
    "views/zero-page/components/settings/icons/local-browser-9a71e5c6fee7.svg",
  teams: "views/zero-page/components/settings/icons/teams-0dc3a5275d31.svg",
  telegram:
    "views/zero-page/components/settings/icons/telegram-2d9ff5d01146.svg",
  vm0: "views/zero-page/components/settings/icons/vm0-0b40ba3af356.svg",
} as const;

type SettingsOnlyIconAssetKey = keyof typeof SETTINGS_ONLY_ICON_ASSET_PATHS;
type SettingsIconAssetKey = ConnectorIconAssetKey | SettingsOnlyIconAssetKey;

function isSettingsOnlyIconAssetKey(
  key: string,
): key is SettingsOnlyIconAssetKey {
  return Object.prototype.hasOwnProperty.call(
    SETTINGS_ONLY_ICON_ASSET_PATHS,
    key,
  );
}

export function settingsIconAssetUrl(key: SettingsIconAssetKey): string {
  const url = maybeSettingsIconAssetUrl(key);
  if (url !== undefined) {
    return url;
  }
  throw new Error(`Missing settings icon asset for "${key}"`);
}

export function maybeSettingsIconAssetUrl(key: string): string | undefined {
  if (isConnectorIconAssetKey(key)) {
    return connectorIconAssetUrl(key);
  }
  if (isSettingsOnlyIconAssetKey(key)) {
    return platformStaticAssetUrl(SETTINGS_ONLY_ICON_ASSET_PATHS[key]);
  }
  return undefined;
}
