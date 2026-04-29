import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const nanoBanana = {
  "nano-banana": {
    label: "Nano Banana",
    category: "ai-image-video",
    environmentMapping: {},
    helpText: "Google Gemini image generation, billed to your org credits",
    featureFlag: FeatureSwitchKey.PlatformConnectors,
    authMethods: {
      platform: {
        label: "Enable",
        helpText:
          "Image generations are billed to your organization's credits. By enabling, you agree that prompts and reference images are sent to the Google Gemini API.",
        secrets: {},
      },
    },
    defaultAuthMethod: "platform",
  },
} as const satisfies Record<string, ConnectorConfig>;
