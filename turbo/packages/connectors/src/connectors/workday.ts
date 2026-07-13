import type { ConnectorConfig } from "../connector-config";
import { FeatureSwitchKey } from "../feature-switch-key";

export const workday = {
  workday: {
    label: "Workday",
    category: "sales-crm-business-operations",
    tags: ["hr", "hcm", "workers", "recruiting", "finance"],
    helpText:
      "Connect a Workday API client for integrations to access tenant REST APIs with automatically refreshed OAuth tokens",
    authMethods: {
      "api-token": {
        featureFlag: FeatureSwitchKey.WorkdayConnector,
        label: "Integration OAuth Credentials",
        helpText:
          "Register an API Client for Integrations in Workday, generate a refresh token for the integration user, then provide the tenant connection details.",
        storage: {
          secrets: [
            "WORKDAY_CLIENT_SECRET",
            "WORKDAY_REFRESH_TOKEN",
            "WORKDAY_ACCESS_TOKEN",
          ],
          variables: ["WORKDAY_HOST", "WORKDAY_TENANT", "WORKDAY_CLIENT_ID"],
        },
        grant: {
          kind: "manual",
          fields: {
            WORKDAY_HOST: {
              label: "Tenant Host",
              publicId: "tenantHost",
              required: true,
              storage: "variable",
              normalize: "host",
              placeholder: "tenant.myworkday.com",
            },
            WORKDAY_TENANT: {
              label: "Tenant Alias",
              publicId: "tenant",
              required: true,
              storage: "variable",
            },
            WORKDAY_CLIENT_ID: {
              label: "Client ID",
              publicId: "clientId",
              required: true,
              storage: "variable",
            },
            WORKDAY_CLIENT_SECRET: {
              label: "Client Secret",
              publicId: "clientSecret",
              required: true,
            },
            WORKDAY_REFRESH_TOKEN: {
              label: "Refresh Token",
              publicId: "refreshToken",
              required: true,
            },
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            host: "$vars.WORKDAY_HOST",
            tenant: "$vars.WORKDAY_TENANT",
            clientId: "$vars.WORKDAY_CLIENT_ID",
            clientSecret: "$secrets.WORKDAY_CLIENT_SECRET",
            refreshToken: "$secrets.WORKDAY_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.WORKDAY_ACCESS_TOKEN",
            refreshToken: "$secrets.WORKDAY_REFRESH_TOKEN",
          },
          refreshableSecrets: ["WORKDAY_ACCESS_TOKEN"],
          envBindings: {
            WORKDAY_TOKEN: "$secrets.WORKDAY_ACCESS_TOKEN",
            WORKDAY_HOST: "$vars.WORKDAY_HOST",
            WORKDAY_TENANT: "$vars.WORKDAY_TENANT",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
