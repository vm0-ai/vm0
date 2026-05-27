import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const zapier = {
  zapier: {
    label: "Zapier",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Zapier account to trigger zaps and use AI Actions (NLA) to automate workflows",
    authMethods: {
      "api-token": {
        featureFlag: FeatureSwitchKey.ZapierConnector,
        label: "API Key",
        grant: {
          kind: "manual",
          fields: {
            ZAPIER_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-zapier-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            ZAPIER_TOKEN: "$secrets.ZAPIER_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
