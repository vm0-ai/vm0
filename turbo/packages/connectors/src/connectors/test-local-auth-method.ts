import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const testLocalAuthMethod = {
  "test-local-auth-method": {
    label: "Test Local Auth Method (internal)",
    category: "data-automation-infrastructure",
    helpText:
      "Synthetic connector-local manual auth method. For automated tests only.",
    authMethods: {
      "app-credentials": {
        featureFlag: FeatureSwitchKey.TestOauthConnector,
        label: "App Credentials",
        helpText: "Test-only connector-local manual credentials.",
        grant: {
          kind: "manual",
          fields: {
            TEST_LOCAL_APP_ID: {
              label: "App ID",
              required: true,
              placeholder: "app-id",
              storage: "variable",
            },
            TEST_LOCAL_APP_SECRET: {
              label: "App Secret",
              required: true,
              placeholder: "app-secret",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            TEST_LOCAL_APP_ID: "$vars.TEST_LOCAL_APP_ID",
            TEST_LOCAL_APP_SECRET: "$secrets.TEST_LOCAL_APP_SECRET",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "app-credentials",
  },
} satisfies Record<string, ConnectorConfig>;
