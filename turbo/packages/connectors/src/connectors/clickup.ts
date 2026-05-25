import type { ConnectorConfig } from "../connectors";

export const clickup = {
  clickup: {
    label: "ClickUp",
    category: "engineering-team-execution",
    helpText:
      "Connect your ClickUp account to manage tasks, projects, and team workflows",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [ClickUp](https://app.clickup.com)\n2. Click your avatar in the upper-right corner and select **Settings**\n3. In the sidebar, click **Apps** (or visit [app.clickup.com/settings/apps](https://app.clickup.com/settings/apps))\n4. Under the **API Token** section, click **Generate** (or **Regenerate** if you already have one)\n5. Click **Copy** to copy the personal token (tokens start with `pk_` and never expire)",
        grant: {
          kind: "manual",
          fields: {
            CLICKUP_TOKEN: {
              label: "API Token",
              required: true,
              placeholder: "pk_...",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            CLICKUP_TOKEN: "$secrets.CLICKUP_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
