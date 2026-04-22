import type { ConnectorConfig } from "../connectors";

export const cloudinary = {
  cloudinary: {
    label: "Cloudinary",
    environmentMapping: {
      CLOUDINARY_TOKEN: "$secrets.CLOUDINARY_TOKEN",
      CLOUDINARY_API_SECRET: "$secrets.CLOUDINARY_API_SECRET",
      CLOUDINARY_CLOUD_NAME: "$vars.CLOUDINARY_CLOUD_NAME",
    },
    helpText:
      "Connect your Cloudinary account to manage images, videos, and media assets with CDN delivery and transformations",
    authMethods: {
      "api-token": {
        label: "API Credentials",
        helpText:
          "1. Log in to the [Cloudinary Console](https://console.cloudinary.com/settings/api-keys)\n2. Go to **Settings** → **API Keys**\n3. Copy your **Cloud Name**, **API Key**, and **API Secret**",
        secrets: {
          CLOUDINARY_TOKEN: {
            label: "API Key",
            required: true,
          },
          CLOUDINARY_API_SECRET: {
            label: "API Secret",
            required: true,
          },
          CLOUDINARY_CLOUD_NAME: {
            label: "Cloud Name",
            required: true,
            type: "variable",
            placeholder: "your-cloud-name",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
