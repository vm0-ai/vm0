import type { ConnectorConfig } from "../connectors";

export const github = {
  github: {
    label: "GitHub",
    category: "engineering-team-execution",
    tags: ["gh", "gh_api_key", "git", "vcs", "scm", "repos"],
    helpText:
      "Connect your GitHub account to access repositories and GitHub features",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with GitHub to grant access.",
        grant: {
          kind: "auth-code",
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
        access: {
          kind: "static",
          outputs: {
            GH_TOKEN: "$secrets.GITHUB_ACCESS_TOKEN",
            GITHUB_TOKEN: "$secrets.GITHUB_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "token-revoke" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
