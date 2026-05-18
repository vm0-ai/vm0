import type { ConnectorConfig } from "../connectors";

export const twocaptcha = {
  twocaptcha: {
    label: "2Captcha",
    category: "data-automation-infrastructure",
    environmentMapping: {
      TWOCAPTCHA_TOKEN: "$secrets.TWOCAPTCHA_TOKEN",
    },
    helpText:
      "Connect 2Captcha to solve reCAPTCHA, hCaptcha, image, and audio captchas during automated browsing",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to [2Captcha](https://2captcha.com/setting)\n2. Open the **API** tab in your account settings\n3. Copy the **API key**\n4. Pass it as the `clientKey` field in the JSON body on every request to `https://api.2captcha.com`",
        secrets: {
          TWOCAPTCHA_TOKEN: {
            label: "API Key",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
