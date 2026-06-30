import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const pexels = {
  pexels: {
    label: "Pexels",
    category: "marketing-content-growth",
    helpText:
      "Connect Pexels to search stock photo and video metadata, download media assets, and insert them into artifacts. Keep Pexels and photographer attribution with generated artifacts, and avoid bulk downloading or rebuilding a stock photo or wallpaper library.",
    tags: ["stock-photos", "stock-videos", "images", "media"],
    authMethods: {
      "api-token": {
        label: "API Key",
        featureFlag: FeatureSwitchKey.PexelsConnector,
        helpText:
          "1. Sign in to [Pexels](https://www.pexels.com)\n2. Open the [Pexels API page](https://www.pexels.com/api/) and request or copy your API key\n3. Paste the key here\n\nvm0 stores the key as a secret and automatically attaches it when calling the Pexels API. Pexels asks API users to include a prominent Pexels link and, where possible, photographer credit when displaying Pexels media.",
        storage: {
          secrets: ["PEXELS_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            PEXELS_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-pexels-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            PEXELS_API_KEY: "$secrets.PEXELS_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
