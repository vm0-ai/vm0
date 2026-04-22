import type { ConnectorConfig } from "../connectors";

export const agentphone = {
  agentphone: {
    label: "AgentPhone",
    environmentMapping: {
      AGENTPHONE_TOKEN: "$secrets.AGENTPHONE_TOKEN",
    },
    helpText:
      "Connect your AgentPhone account to make and receive phone calls, send SMS, manage phone numbers, and build voice AI agents",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign up at [agentphone.to](https://agentphone.to)\n2. Go to **Dashboard > API Keys**\n3. Create a new API key and copy it (starts with `sk_live_`)",
        secrets: {
          AGENTPHONE_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "sk_live_...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
