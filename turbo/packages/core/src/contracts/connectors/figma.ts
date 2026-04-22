import { FeatureSwitchKey } from "../../feature-switch-key";
import type { ConnectorConfig } from "../connectors";

export const figma = {
  figma: {
    label: "Figma",
    environmentMapping: {
      FIGMA_TOKEN: "$secrets.FIGMA_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.FigmaConnector,
    helpText: "Connect your Figma account to access design files and projects",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Figma to grant access.",
        secrets: {
          FIGMA_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          FIGMA_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
      "api-token": {
        label: "Personal Access Token",
        helpText:
          "1. Log in to [Figma](https://www.figma.com) and open the file browser\n2. Click the account menu in the top-left corner and select **Settings**\n3. Select the **Security** tab\n4. Scroll to the **Personal access tokens** section and click **Generate new token**\n5. Enter a name for the token, assign the desired scopes, and press Return/Enter\n6. Copy the generated token immediately — it will not be shown again",
        secrets: {
          FIGMA_TOKEN: {
            label: "Personal Access Token",
            required: true,
            placeholder: "figd_xxxxxxxx",
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://www.figma.com/oauth",
      tokenUrl: "https://api.figma.com/v1/oauth/token",
      scopes: [
        "current_user:read",
        "file_content:read",
        "file_metadata:read",
        "file_versions:read",
        "projects:read",
        "file_comments:read",
        "file_comments:write",
        "library_assets:read",
        "library_content:read",
      ],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
