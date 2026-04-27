import type { ConnectorConfig } from "../connectors";

export const dropboxSign = {
  "dropbox-sign": {
    label: "Dropbox Sign",
    category: "data-automation-infrastructure",
    tags: ["hellosign", "e-signature", "signature", "sign", "document"],
    environmentMapping: {
      DROPBOX_SIGN_TOKEN: "$secrets.DROPBOX_SIGN_TOKEN",
    },
    helpText:
      "Connect your Dropbox Sign (formerly HelloSign) account to send, track, and download e-signature requests",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Dropbox Sign](https://sign.dropbox.com)\n2. Click **API** in the left sidebar and open the **API Dashboard**\n3. Click **Reveal key** for an existing key, or **Generate key** to create a new one\n4. Copy the 40-character hex key and paste it here\n\nTip: While developing, add `test_mode=1` to signature-request calls to avoid billing and real emails.",
        secrets: {
          DROPBOX_SIGN_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "40-character hex key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
