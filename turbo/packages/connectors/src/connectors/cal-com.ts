import type { ConnectorConfig } from "../connectors";

export const calCom = {
  "cal-com": {
    label: "Cal.com",
    category: "meetings-scheduling",
    helpText:
      "Connect your Cal.com account to manage scheduling, bookings, and calendar events",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Cal.com](https://app.cal.com)\n2. Go to **Settings** → **Developer** → **API Keys**\n3. Click **Create API Key**\n4. Copy the generated key",
        grant: {
          kind: "manual",
          fields: {
            CALCOM_TOKEN: {
              label: "API Token",
              required: true,
              placeholder: "cal_live_xxxxxxxx",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            CALCOM_TOKEN: "$secrets.CALCOM_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
