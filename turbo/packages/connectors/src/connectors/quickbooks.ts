import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const quickbooks = {
  quickbooks: {
    label: "QuickBooks",
    category: "data-automation-infrastructure",
    helpText:
      "Connect QuickBooks Online to access accounting data, customers, invoices, bills, and reports",
    tags: ["accounting", "finance", "invoices", "intuit", "qbo"],
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.QuickBooksConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Intuit to grant QuickBooks Online access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "QUICKBOOKS_OAUTH_CLIENT_ID",
          clientSecretEnv: "QUICKBOOKS_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["QUICKBOOKS_ACCESS_TOKEN", "QUICKBOOKS_REFRESH_TOKEN"],
          variables: ["QUICKBOOKS_REALM_ID"],
        },
        grant: {
          kind: "auth-code",
          scopes: [
            "com.intuit.quickbooks.accounting",
            "openid",
            "profile",
            "email",
          ],
          outputs: {
            accessToken: "$secrets.QUICKBOOKS_ACCESS_TOKEN",
            refreshToken: "$secrets.QUICKBOOKS_REFRESH_TOKEN",
            realmId: "$vars.QUICKBOOKS_REALM_ID",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.QUICKBOOKS_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.QUICKBOOKS_ACCESS_TOKEN",
            refreshToken: "$secrets.QUICKBOOKS_REFRESH_TOKEN",
          },
          refreshableSecrets: ["QUICKBOOKS_ACCESS_TOKEN"],
          envBindings: {
            QUICKBOOKS_TOKEN: "$secrets.QUICKBOOKS_ACCESS_TOKEN",
            QUICKBOOKS_REALM_ID: "$vars.QUICKBOOKS_REALM_ID",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
