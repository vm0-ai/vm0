import { FeatureSwitchKey } from "../feature-switch-key";
import type { ConnectorConfig } from "../connectors";

export const localBrowser = {
  "local-browser": {
    label: "Local Browser",
    category: "data-automation-infrastructure",
    helpText:
      "Connect a local browser extension so Zero can use user-authorized browser context and page controls",
    authMethods: {
      api: {
        featureFlag: FeatureSwitchKey.LocalBrowserUse,
        label: "Browser Extension",
        helpText:
          "1. Install the Zero Local Browser extension\n2. Pair the extension with your Zero account\n3. Keep the extension connected, then return here and click **Connect** once it appears online",
        grant: { kind: "managed" },
        access: { kind: "none" },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api",
    tags: ["browser", "chrome", "extension", "local", "web"],
  },
} as const satisfies Record<string, ConnectorConfig>;
