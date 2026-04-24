import type { ConnectorConfig } from "../connectors";

export const pika = {
  pika: {
    label: "Pika",
    category: "ai-image-video",
    environmentMapping: {
      PIKA_TOKEN: "$secrets.PIKA_TOKEN",
    },
    helpText:
      "Connect your Pika Developer account to join video meetings (Google Meet, Zoom) as a real-time AI avatar with voice cloning",
    authMethods: {
      "api-token": {
        label: "Developer Key",
        helpText:
          "1. Go to [pika.me/dev](https://www.pika.me/dev/)\n2. Sign in or create an account\n3. Create a new Developer Key\n4. Copy the key (format: `dk_...`)",
        secrets: {
          PIKA_TOKEN: {
            label: "Developer Key",
            required: true,
            placeholder: "dk_...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
