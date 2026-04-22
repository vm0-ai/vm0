import type { ConnectorConfig } from "../connectors";

export const cloudflare = {
  cloudflare: {
    label: "Cloudflare",
    environmentMapping: {
      CLOUDFLARE_TOKEN: "$secrets.CLOUDFLARE_TOKEN",
    },
    helpText:
      "Connect your Cloudflare account to manage DNS, zones, workers, and other Cloudflare services",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com)\n2. Go to **My Profile** → **API Tokens**\n3. Click **Create Token** and configure the required permissions\n4. Copy the generated token",
        secrets: {
          CLOUDFLARE_TOKEN: {
            label: "API Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
