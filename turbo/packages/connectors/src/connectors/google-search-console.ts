import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const googleSearchConsole = {
  "google-search-console": {
    label: "Google Search Console",
    category: "marketing-content-growth",
    tags: [
      "seo",
      "search console",
      "webmasters",
      "search analytics",
      "indexing",
      "sitemaps",
    ],
    helpText:
      "Connect your Google account to access Search Console performance, indexing, sitemap, and site data",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.GoogleSearchConsoleConnector,
        showExperimentalLabel: false,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant Google Search Console access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
          clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: [
            "GOOGLE_SEARCH_CONSOLE_ACCESS_TOKEN",
            "GOOGLE_SEARCH_CONSOLE_REFRESH_TOKEN",
          ],
          variables: [],
        },
        grant: {
          kind: "auth-code",
          scopes: [
            "https://www.googleapis.com/auth/webmasters",
            "https://www.googleapis.com/auth/userinfo.email",
          ],
          outputs: {
            accessToken: "$secrets.GOOGLE_SEARCH_CONSOLE_ACCESS_TOKEN",
            refreshToken: "$secrets.GOOGLE_SEARCH_CONSOLE_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.GOOGLE_SEARCH_CONSOLE_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.GOOGLE_SEARCH_CONSOLE_ACCESS_TOKEN",
            refreshToken: "$secrets.GOOGLE_SEARCH_CONSOLE_REFRESH_TOKEN",
          },
          refreshableSecrets: ["GOOGLE_SEARCH_CONSOLE_ACCESS_TOKEN"],
          envBindings: {
            GOOGLE_SEARCH_CONSOLE_TOKEN:
              "$secrets.GOOGLE_SEARCH_CONSOLE_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
