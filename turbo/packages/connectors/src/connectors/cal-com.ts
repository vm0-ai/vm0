import type { ConnectorConfig } from "../connector-config";
import { FeatureSwitchKey } from "../feature-switch-key";

export const calCom = {
  "cal-com": {
    label: "Cal.com",
    category: "meetings-scheduling",
    helpText:
      "Connect your Cal.com account to manage scheduling, bookings, and calendar events",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.CalComConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Cal.com to grant scheduling access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "CALCOM_OAUTH_CLIENT_ID",
          clientSecretEnv: "CALCOM_OAUTH_CLIENT_SECRET",
        },
        storage: {
          version: 1,
          secrets: ["CALCOM_ACCESS_TOKEN", "CALCOM_REFRESH_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "auth-code",
          scopes: [
            "BOOKING_READ",
            "BOOKING_WRITE",
            "EVENT_TYPE_READ",
            "EVENT_TYPE_WRITE",
            "PROFILE_READ",
            "SCHEDULE_READ",
          ],
          outputs: {
            accessToken: "$secrets.CALCOM_ACCESS_TOKEN",
            refreshToken: "$secrets.CALCOM_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.CALCOM_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.CALCOM_ACCESS_TOKEN",
            refreshToken: "$secrets.CALCOM_REFRESH_TOKEN",
          },
          refreshableSecrets: ["CALCOM_ACCESS_TOKEN"],
          envBindings: {
            CALCOM_TOKEN: "$secrets.CALCOM_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
      "api-token": {
        featureFlag: FeatureSwitchKey.CalComConnector,
        label: "API Token",
        helpText:
          "1. Log in to [Cal.com](https://app.cal.com)\n2. Go to **Settings** → **Developer** → **API Keys**\n3. Click **Create API Key**\n4. Copy the generated key",
        storage: {
          version: 1,
          secrets: ["CALCOM_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            CALCOM_TOKEN: {
              label: "API Token",
              publicId: "apiToken",
              required: true,
              placeholder: "cal_live_xxxxxxxx",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            CALCOM_TOKEN: "$secrets.CALCOM_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
