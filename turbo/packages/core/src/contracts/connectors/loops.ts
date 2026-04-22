import type { ConnectorConfig } from "../connectors";

export const loops = {
  loops: {
    label: "Loops",
    environmentMapping: {
      LOOPS_TOKEN: "$secrets.LOOPS_TOKEN",
    },
    helpText:
      "Connect your Loops account to send behavioral and transactional emails for your SaaS product",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Loops](https://app.loops.so)\n2. Go to **Settings** → **API**\n3. Click **Generate key**\n4. Copy the generated API key",
        secrets: {
          LOOPS_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "d2d561f5ff80136f69b4b5a31b9fb3c9",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
