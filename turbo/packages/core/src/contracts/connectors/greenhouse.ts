import type { ConnectorConfig } from "../connectors";

export const greenhouse = {
  greenhouse: {
    label: "Greenhouse",
    environmentMapping: {
      GREENHOUSE_TOKEN: "$secrets.GREENHOUSE_TOKEN",
    },
    helpText:
      "Connect your Greenhouse account to read candidates, applications, jobs, offers, and scheduled interviews, and to create candidates and activity-feed notes via the Harvest API. Note: Harvest v1/v2 will be deprecated on August 31, 2026 — migrate to OAuth v3 before that date.",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. In Greenhouse, click **Configure** (gear icon) → **Dev Center** (left sidebar)\n2. Click **API Credential Management** → **Create new API credentials**\n3. For **API type**, select **Harvest API** (v1/v2). For **Partner**, choose **Custom** (or **Unlisted vendor**). Description: **vm0**\n4. Select the endpoints you want this key to access (permission scoping)\n5. Click **View and store credentials** and copy the API key — it is only shown once\n6. Paste it here\n\n**Note:** Harvest v1/v2 will be deprecated on August 31, 2026; migrate to OAuth v3 before that date.",
        secrets: {
          GREENHOUSE_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-greenhouse-harvest-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
