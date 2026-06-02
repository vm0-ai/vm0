import type { ConnectorConfig } from "../connectors";

export const calendly = {
  calendly: {
    label: "Calendly",
    category: "meetings-scheduling",
    helpText:
      "Connect your Calendly account to access scheduling data, event types, and invitee information",
    authMethods: {
      "api-token": {
        label: "Personal Access Token",
        helpText:
          "1. Log in to [Calendly](https://calendly.com)\n2. Go to **Integrations > API & Webhooks**\n3. Generate a Personal Access Token\n4. Copy the token",
        storage: {
          secrets: ["CALENDLY_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            CALENDLY_TOKEN: {
              label: "Personal Access Token",
              required: true,
              placeholder: "your-calendly-token",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            CALENDLY_TOKEN: "$secrets.CALENDLY_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
