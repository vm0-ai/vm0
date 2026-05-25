import type { ConnectorConfig } from "../connectors";

export const etherscan = {
  etherscan: {
    label: "Etherscan",
    category: "data-automation-infrastructure",
    environmentMapping: {
      ETHERSCAN_API_KEY: "$secrets.ETHERSCAN_API_KEY",
    },
    helpText:
      "Connect Etherscan API V2 to query Ethereum and supported EVM-compatible chains with one API key",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to [Etherscan](https://etherscan.io)\n2. Open your [API Dashboard](https://etherscan.io/myapikey)\n3. Click **Add +** to create a new API key\n4. Use the key with Etherscan API V2 requests; one key works across supported chains via the `chainid` parameter",
        secrets: {
          ETHERSCAN_API_KEY: {
            label: "API Key",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
