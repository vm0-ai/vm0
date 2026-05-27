import type { ConnectorConfig } from "../connectors";

export const coingecko = {
  coingecko: {
    label: "CoinGecko",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your CoinGecko account to access crypto market data, prices, coins, exchanges, NFTs, and onchain data",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign up or log in to [CoinGecko](https://www.coingecko.com/en/api)\n2. Open the **Developer Dashboard**\n3. Click **Add New Key** to create a Demo or Pro API key\n4. Copy the API key",
        grant: {
          kind: "manual",
          fields: {
            COINGECKO_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-coingecko-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            COINGECKO_TOKEN: "$secrets.COINGECKO_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
