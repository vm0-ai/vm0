import type { ConnectorConfig } from "../connector-config";

export const twilio = {
  twilio: {
    label: "Twilio",
    category: "communication-collaboration",
    tags: ["sms", "voice", "whatsapp", "verify", "lookup", "messaging"],
    helpText:
      "Connect your Twilio account to send SMS / WhatsApp / MMS, place voice calls, look up phone numbers, and run Verify OTP flows",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Open the [Twilio Console](https://console.twilio.com) — your **Account SID** is shown on the dashboard\n2. Click **View** next to **Auth Token** to reveal the live auth token\n3. Copy both values and paste them below — the SID always starts with `AC`",
        storage: {
          secrets: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            TWILIO_ACCOUNT_SID: {
              label: "Account SID",
              publicId: "accountSid",
              required: true,
              placeholder: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            },
            TWILIO_AUTH_TOKEN: {
              label: "Auth Token",
              publicId: "authToken",
              required: true,
              placeholder: "32-char hex token",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            TWILIO_ACCOUNT_SID: "$secrets.TWILIO_ACCOUNT_SID",
            TWILIO_AUTH_TOKEN: "$secrets.TWILIO_AUTH_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
