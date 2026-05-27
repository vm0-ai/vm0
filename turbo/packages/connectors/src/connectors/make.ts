import type { ConnectorConfig } from "../connectors";

export const make = {
  make: {
    label: "Make",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Make account to manage scenarios, organizations, and automation workflows",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Make](https://www.make.com)\n2. Click your **avatar** at the bottom-left corner\n3. Select **Profile**, then open the **API** tab\n4. Click **Add token**\n5. Enter a **Label** (custom name to identify the token)\n6. Select the required **Scopes** (permissions)\n7. Click **Save**\n8. Copy the token and store it in a safe place (it will be hidden once you leave the page)",
        grant: {
          kind: "manual",
          fields: {
            MAKE_TOKEN: {
              label: "API Token",
              required: true,
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            MAKE_TOKEN: "$secrets.MAKE_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
