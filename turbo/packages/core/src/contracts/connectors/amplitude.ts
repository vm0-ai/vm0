import type { ConnectorConfig } from "../connectors";

export const amplitude = {
  amplitude: {
    label: "Amplitude",
    tags: ["analytics", "product-analytics", "events", "funnels"],
    environmentMapping: {
      AMPLITUDE_API_KEY: "$secrets.AMPLITUDE_API_KEY",
      AMPLITUDE_SECRET_KEY: "$secrets.AMPLITUDE_SECRET_KEY",
    },
    helpText:
      "Connect your Amplitude project to query events, funnels, retention, cohorts, and ingest new events",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. In Amplitude, open **Organization Settings** (top right nav) → **Projects** and click the project you want to connect\n2. Copy the **API Key** from the project table (Manager role required)\n3. Click **Generate Secret Key**, name it, and copy it immediately (the secret is only shown once)\n4. Paste both values into the fields below",
        secrets: {
          AMPLITUDE_API_KEY: {
            label: "API Key",
            required: true,
            placeholder: "32-char hex key",
          },
          AMPLITUDE_SECRET_KEY: {
            label: "Secret Key",
            required: true,
            placeholder: "32-char hex secret",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
