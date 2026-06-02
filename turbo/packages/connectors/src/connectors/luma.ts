import type { ConnectorConfig } from "../connectors";

export const luma = {
  luma: {
    label: "Luma",
    category: "meetings-scheduling",
    helpText:
      "Connect your Luma account to manage events, guests, tickets, and calendar data via the Luma API",
    tags: ["events", "calendar", "tickets", "guests", "rsvp"],
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in at [lu.ma](https://lu.ma)\n2. Go to Calendars Home → select your calendar → Settings → Developer\n3. Generate or copy your API key\n4. Paste the key here",
        storage: {
          secrets: ["LUMA_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            LUMA_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-luma-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            LUMA_API_KEY: "$secrets.LUMA_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
