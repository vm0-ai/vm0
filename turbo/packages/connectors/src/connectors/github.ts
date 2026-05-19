import type { ConnectorConfig } from "../connectors";

export const github = {
  github: {
    label: "GitHub",
    category: "engineering-team-execution",
    tags: ["gh", "gh_api_key", "git", "vcs", "scm", "repos"],
    environmentMapping: {
      GH_TOKEN: "$secrets.GITHUB_ACCESS_TOKEN",
      GITHUB_TOKEN: "$secrets.GITHUB_ACCESS_TOKEN",
    },
    helpText:
      "Connect your GitHub account to access repositories and GitHub features",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with GitHub to grant access.",
        secrets: {
          GITHUB_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      client: {
        clientRegistration: "static",
        clientType: "confidential",
        tokenEndpointAuthMethod: "client_secret_post",
        clientIdEnv: "GH_OAUTH_CLIENT_ID",
        clientSecretEnv: "GH_OAUTH_CLIENT_SECRET",
      },
      scopes: ["repo", "project", "workflow"],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
