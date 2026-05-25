import type { ConnectorConfig } from "../connectors";

export const chatwoot = {
  chatwoot: {
    label: "Chatwoot",
    category: "communication-collaboration",
    helpText:
      "Connect your Chatwoot account to manage conversations, contacts, and customer support workflows",
    authMethods: {
      "api-token": {
        label: "API Access Token",
        helpText:
          "1. Log in to [Chatwoot](https://app.chatwoot.com) with an administrator account\n2. Click on your **avatar image** in the bottom left corner of the screen\n3. Select **Profile Settings** from the menu\n4. Scroll to the bottom of the Profile Settings page\n5. Copy the **Personal Access Token** displayed there",
        grant: {
          kind: "manual",
          fields: {
            CHATWOOT_TOKEN: {
              label: "API Access Token",
              required: true,
              placeholder: "your-chatwoot-access-token",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            CHATWOOT_TOKEN: "$secrets.CHATWOOT_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
