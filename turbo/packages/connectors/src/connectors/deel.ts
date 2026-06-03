import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const deel = {
  deel: {
    label: "Deel",
    category: "sales-crm-business-operations",
    helpText:
      "Connect your Deel account to access HR, payroll, and contractor data",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.DeelConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Deel to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "DEEL_OAUTH_CLIENT_ID",
          clientSecretEnv: "DEEL_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["DEEL_ACCESS_TOKEN", "DEEL_REFRESH_TOKEN"],
          variables: [],
          secretRoles: {
            accessToken: "DEEL_ACCESS_TOKEN",
            refreshToken: "DEEL_REFRESH_TOKEN",
          },
        },
        grant: {
          kind: "auth-code",
          scopes: [
            "contracts:read",
            "people:read",
            "organizations:read",
            "payslips:read",
            "time-off:read",
            "time-off:write",
            "invoice-adjustments:read",
            "invoice-adjustments:write",
          ],
        },
        access: {
          kind: "refresh-token",
          envBindings: {
            DEEL_TOKEN: "$secrets.DEEL_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
      "api-token": {
        label: "API Token",
        helpText:
          "1. Create a [Deel](https://app.deel.com) account and verify your email\n2. Navigate to the **Developer Center**\n3. Select the **API Sandbox** tab (or **Production** for live credentials)\n4. Click **Create Sandbox** and enter a unique email and password\n5. Click **Confirm** to finalize sandbox creation\n6. Locate your **API Key / Access Token** in the Developer Center\n7. Copy and store the token securely",
        storage: {
          secrets: ["DEEL_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            DEEL_TOKEN: {
              label: "API Token",
              required: true,
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            DEEL_TOKEN: "$secrets.DEEL_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
