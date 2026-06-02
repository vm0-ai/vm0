import type { ConnectorConfig } from "../connectors";

export const htmlcsstoimage = {
  htmlcsstoimage: {
    label: "HTML/CSS to Image",
    category: "marketing-content-growth",
    generation: ["image"],
    helpText:
      "Connect your HTML/CSS to Image account to generate images from HTML and CSS",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [HTML/CSS to Image](https://htmlcsstoimage.com/dashboard)\n2. Go to your **Dashboard**\n3. Locate your **User ID** and **API Key** displayed on the dashboard\n4. Copy the **API Key** (used as the password in HTTP Basic authentication)",
        storage: {
          secrets: ["HCTI_API_KEY"],
          variables: ["HCTI_USER_ID"],
        },
        grant: {
          kind: "manual",
          fields: {
            HCTI_API_KEY: {
              label: "API Key",
              required: true,
            },
            HCTI_USER_ID: {
              label: "User ID",
              required: true,
              storage: "variable",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            HCTI_API_KEY: "$secrets.HCTI_API_KEY",
            HCTI_USER_ID: "$vars.HCTI_USER_ID",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
