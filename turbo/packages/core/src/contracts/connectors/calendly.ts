import type { ConnectorConfig } from "../connectors";

export const calendly = {
  calendly: {
    label: "Calendly",
    environmentMapping: {
      CALENDLY_TOKEN: "$secrets.CALENDLY_TOKEN",
    },
    helpText:
      "Connect your Calendly account to access scheduling data, event types, and invitee information",
    authMethods: {
      "api-token": {
        label: "Personal Access Token",
        helpText:
          "1. Log in to [Calendly](https://calendly.com)\n2. Go to **Integrations > API & Webhooks**\n3. Generate a Personal Access Token\n4. Copy the token",
        secrets: {
          CALENDLY_TOKEN: {
            label: "Personal Access Token",
            required: true,
            placeholder: "your-calendly-token",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
