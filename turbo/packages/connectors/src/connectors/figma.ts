import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const figma = {
  figma: {
    label: "Figma",
    category: "docs-files-knowledge",
    helpText: "Connect your Figma account to access design files and projects",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.FigmaConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Figma to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "FIGMA_OAUTH_CLIENT_ID",
          clientSecretEnv: "FIGMA_OAUTH_CLIENT_SECRET",
        },
        grant: {
          kind: "auth-code",
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
        access: {
          kind: "refresh-token",
          accessToken: "FIGMA_ACCESS_TOKEN",
          refreshToken: "FIGMA_REFRESH_TOKEN",
          envBindings: {
            FIGMA_TOKEN: "$secrets.FIGMA_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
      "api-token": {
        label: "Personal Access Token",
        helpText:
          "1. Log in to [Figma](https://www.figma.com) and open the file browser\n2. Click the account menu in the top-left corner and select **Settings**\n3. Select the **Security** tab\n4. Scroll to the **Personal access tokens** section and click **Generate new token**\n5. Enter a name for the token, assign the desired scopes, and press Return/Enter\n6. Copy the generated token immediately — it will not be shown again",
        grant: {
          kind: "manual",
          fields: {
            FIGMA_TOKEN: {
              label: "Personal Access Token",
              required: true,
              placeholder: "figd_xxxxxxxx",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            FIGMA_TOKEN: "$secrets.FIGMA_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
