import type { ConnectorConfig } from "../connector-config";
import { FeatureSwitchKey } from "../feature-switch-key";

export const copper = {
  copper: {
    label: "Copper",
    category: "sales-crm-business-operations",
    tags: ["crm", "sales", "leads", "opportunities", "companies"],
    helpText:
      "Connect Copper CRM to search and manage people, companies, leads, opportunities, projects, tasks, and activities",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.CopperConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Copper to grant CRM access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "COPPER_OAUTH_CLIENT_ID",
          clientSecretEnv: "COPPER_OAUTH_CLIENT_SECRET",
        },
        storage: {
          version: 1,
          secrets: ["COPPER_ACCESS_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "auth-code",
          scopes: ["developer/v1/all"],
          outputs: { accessToken: "$secrets.COPPER_ACCESS_TOKEN" },
        },
        access: {
          kind: "static",
          envBindings: { COPPER_TOKEN: "$secrets.COPPER_ACCESS_TOKEN" },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
