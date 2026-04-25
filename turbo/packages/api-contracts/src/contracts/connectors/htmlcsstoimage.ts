import type { ConnectorConfig } from "../connectors";

export const htmlcsstoimage = {
  htmlcsstoimage: {
    label: "HTML/CSS to Image",
    category: "marketing-content-growth",
    environmentMapping: {
      HCTI_API_KEY: "$secrets.HCTI_API_KEY",
      HCTI_USER_ID: "$vars.HCTI_USER_ID",
    },
    helpText:
      "Connect your HTML/CSS to Image account to generate images from HTML and CSS",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [HTML/CSS to Image](https://htmlcsstoimage.com/dashboard)\n2. Go to your **Dashboard**\n3. Locate your **User ID** and **API Key** displayed on the dashboard\n4. Copy the **API Key** (used as the password in HTTP Basic authentication)",
        secrets: {
          HCTI_API_KEY: {
            label: "API Key",
            required: true,
          },
          HCTI_USER_ID: {
            label: "User ID",
            required: true,
            type: "variable",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
