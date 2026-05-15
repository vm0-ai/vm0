import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const zapier = {
  zapier: {
    label: "Zapier",
    category: "data-automation-infrastructure",
    environmentMapping: {
      ZAPIER_TOKEN: "$secrets.ZAPIER_TOKEN",
    },
    helpText:
      "Connect your Zapier account to trigger zaps and use AI Actions (NLA) to automate workflows",
    authMethods: {
      "api-token": {
        featureFlag: FeatureSwitchKey.ZapierConnector,
        label: "API Key",
        secrets: {
          ZAPIER_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-zapier-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
