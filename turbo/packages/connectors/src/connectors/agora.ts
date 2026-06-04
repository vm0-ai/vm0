import type { ConnectorConfig } from "../connectors";

export const agora = {
  agora: {
    label: "Agora",
    category: "communication-collaboration",
    tags: ["rtc", "rtm", "video", "voice", "live-streaming", "recording"],
    helpText:
      "Connect your Agora project to manage real-time voice and video channels, cloud recording, messaging, and REST API operations",
    authMethods: {
      "api-token": {
        label: "REST credentials",
        helpText:
          "1. In [Agora Console](https://console.agora.io), open **Developer Toolkit > RESTful API**\n2. Click **Add a secret** to create a Customer ID and Customer Secret, then download and store the secret securely\n3. Copy your project **App ID** from Agora Console\n4. Optionally copy your **App Certificate** if you need to generate RTC or RTM tokens",
        storage: {
          secrets: [
            "AGORA_CUSTOMER_ID",
            "AGORA_CUSTOMER_SECRET",
            "AGORA_APP_CERTIFICATE",
          ],
          variables: ["AGORA_APP_ID"],
        },
        grant: {
          kind: "manual",
          fields: {
            AGORA_CUSTOMER_ID: {
              label: "Customer ID",
              required: true,
              placeholder: "your-agora-customer-id",
            },
            AGORA_CUSTOMER_SECRET: {
              label: "Customer Secret",
              required: true,
              placeholder: "your-agora-customer-secret",
            },
            AGORA_APP_ID: {
              label: "App ID",
              required: true,
              storage: "variable",
              placeholder: "your-agora-app-id",
            },
            AGORA_APP_CERTIFICATE: {
              label: "App Certificate",
              required: false,
              placeholder: "optional-agora-app-certificate",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            AGORA_CUSTOMER_ID: "$secrets.AGORA_CUSTOMER_ID",
            AGORA_CUSTOMER_SECRET: "$secrets.AGORA_CUSTOMER_SECRET",
            AGORA_APP_ID: "$vars.AGORA_APP_ID",
            AGORA_APP_CERTIFICATE: {
              valueRef: "$secrets.AGORA_APP_CERTIFICATE",
              required: false,
            },
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
