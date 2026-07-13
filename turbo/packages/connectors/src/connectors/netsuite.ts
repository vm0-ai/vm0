import type { ConnectorConfig } from "../connector-config";
import { FeatureSwitchKey } from "../feature-switch-key";

export const netsuite = {
  netsuite: {
    label: "NetSuite",
    category: "sales-crm-business-operations",
    tags: ["erp", "accounting", "suiteql", "restlets", "oracle"],
    helpText:
      "Connect a NetSuite integration record to access REST Web Services, SuiteQL, and RESTlets with automatically refreshed OAuth tokens",
    authMethods: {
      "api-token": {
        featureFlag: FeatureSwitchKey.NetSuiteConnector,
        label: "OAuth 2.0 Credentials",
        helpText:
          "Create an OAuth 2.0 integration record in NetSuite, authorize it once, then provide the account ID, client credentials, and refresh token.",
        storage: {
          secrets: [
            "NETSUITE_CLIENT_SECRET",
            "NETSUITE_REFRESH_TOKEN",
            "NETSUITE_ACCESS_TOKEN",
          ],
          variables: ["NETSUITE_ACCOUNT_SUBDOMAIN", "NETSUITE_CLIENT_ID"],
        },
        grant: {
          kind: "manual",
          fields: {
            NETSUITE_ACCOUNT_SUBDOMAIN: {
              label: "Account Domain Prefix",
              publicId: "accountSubdomain",
              required: true,
              storage: "variable",
              placeholder: "1234567-sb1",
            },
            NETSUITE_CLIENT_ID: {
              label: "Client ID",
              publicId: "clientId",
              required: true,
              storage: "variable",
            },
            NETSUITE_CLIENT_SECRET: {
              label: "Client Secret",
              publicId: "clientSecret",
              required: true,
            },
            NETSUITE_REFRESH_TOKEN: {
              label: "Refresh Token",
              publicId: "refreshToken",
              required: true,
            },
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            accountSubdomain: "$vars.NETSUITE_ACCOUNT_SUBDOMAIN",
            clientId: "$vars.NETSUITE_CLIENT_ID",
            clientSecret: "$secrets.NETSUITE_CLIENT_SECRET",
            refreshToken: "$secrets.NETSUITE_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.NETSUITE_ACCESS_TOKEN",
            refreshToken: "$secrets.NETSUITE_REFRESH_TOKEN",
          },
          refreshableSecrets: ["NETSUITE_ACCESS_TOKEN"],
          envBindings: {
            NETSUITE_TOKEN: "$secrets.NETSUITE_ACCESS_TOKEN",
            NETSUITE_ACCOUNT_SUBDOMAIN: "$vars.NETSUITE_ACCOUNT_SUBDOMAIN",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
