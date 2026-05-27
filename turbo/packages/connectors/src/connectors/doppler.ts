import type { ConnectorConfig } from "../connectors";

export const doppler = {
  doppler: {
    label: "Doppler",
    category: "engineering-team-execution",
    helpText:
      "Connect your Doppler account to fetch secrets and environment variables from your projects and configs",
    authMethods: {
      "api-token": {
        label: "Service Token",
        helpText:
          "1. Log in to [Doppler](https://dashboard.doppler.com)\n2. Go to your project, then select a config (environment)\n3. Click the **Access** tab\n4. Click **+ Generate Service Token**\n5. Set permissions to **Read** and copy the token",
        grant: {
          kind: "manual",
          fields: {
            DOPPLER_TOKEN: {
              label: "Service Token",
              required: true,
              placeholder: "dp.st.dev.xxxx",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            DOPPLER_TOKEN: "$secrets.DOPPLER_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
