import type { ConnectorConfig } from "../connectors";

export const brightData = {
  "bright-data": {
    label: "Bright Data",
    environmentMapping: {
      BRIGHTDATA_TOKEN: "$secrets.BRIGHTDATA_TOKEN",
    },
    helpText:
      "Connect your Bright Data account to scrape websites, manage proxies, and access web data",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Bright Data](https://brightdata.com/cp)\n2. Go to **Account settings**\n3. Click **Add API key** and configure permissions\n4. Copy the token (shown only once)",
        secrets: {
          BRIGHTDATA_TOKEN: {
            label: "API Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
