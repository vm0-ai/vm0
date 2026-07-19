import type { ConnectorConfig } from "../connector-config";
import { FeatureSwitchKey } from "../feature-switch-key";

export const datadog = {
  datadog: {
    label: "Datadog",
    category: "data-automation-infrastructure",
    tags: ["observability", "logs", "metrics", "traces", "monitors"],
    helpText:
      "Connect Datadog to investigate logs, metrics, traces, dashboards, monitors, incidents, and service health",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.DatadogConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Datadog and select your Datadog site.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "DATADOG_OAUTH_CLIENT_ID",
          clientSecretEnv: "DATADOG_OAUTH_CLIENT_SECRET",
        },
        storage: {
          version: 1,
          secrets: ["DATADOG_ACCESS_TOKEN", "DATADOG_REFRESH_TOKEN"],
          variables: ["DATADOG_DOMAIN"],
        },
        grant: {
          kind: "auth-code",
          scopes: [
            "dashboards_read",
            "events_read",
            "incident_read",
            "logs_read_index_data",
            "metrics_read",
            "monitors_read",
            "slos_read",
          ],
          outputs: {
            accessToken: "$secrets.DATADOG_ACCESS_TOKEN",
            refreshToken: "$secrets.DATADOG_REFRESH_TOKEN",
            domain: "$vars.DATADOG_DOMAIN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.DATADOG_REFRESH_TOKEN",
            domain: "$vars.DATADOG_DOMAIN",
          },
          outputs: {
            accessToken: "$secrets.DATADOG_ACCESS_TOKEN",
            refreshToken: "$secrets.DATADOG_REFRESH_TOKEN",
          },
          refreshableSecrets: ["DATADOG_ACCESS_TOKEN"],
          envBindings: {
            DATADOG_TOKEN: "$secrets.DATADOG_ACCESS_TOKEN",
            DATADOG_DOMAIN: "$vars.DATADOG_DOMAIN",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
