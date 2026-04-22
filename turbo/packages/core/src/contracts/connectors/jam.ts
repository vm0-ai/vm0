import type { ConnectorConfig } from "../connectors";

export const jam = {
  jam: {
    label: "Jam",
    environmentMapping: {
      JAM_TOKEN: "$secrets.JAM_TOKEN",
    },
    helpText:
      "Connect your Jam account to capture bugs, manage reports, and access debugging telemetry",
    authMethods: {
      "api-token": {
        label: "Personal Access Token",
        helpText:
          '1. Log in to [Jam](https://jam.dev)\n2. Go to **Settings > Integrations > AI Agents**\n3. Scroll down to the **Personal Access Tokens** section\n4. Click **Create token**\n5. Enter a name for the token (e.g., "Cursor" or "Claude Code")\n6. Choose an expiration period (7 days, 30 days, 90 days, or 1 year)\n7. Select at least one scope (`mcp:read` for viewing or `mcp:write` for editing)\n8. Click **Create**\n9. Copy the token immediately (it will not be displayed again)',
        secrets: {
          JAM_TOKEN: {
            label: "Personal Access Token",
            required: true,
            placeholder: "jam_pat_...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
