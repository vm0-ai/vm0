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
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "GH_OAUTH_CLIENT_ID",
          clientSecretEnv: "GH_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["GITHUB_ACCESS_TOKEN"],
          variables: [],
          secretRoles: {
            accessToken: "GITHUB_ACCESS_TOKEN",
          },
        },
        grant: {
          kind: "auth-code",
          scopes: ["repo", "project", "workflow"],
        },
        access: {
          kind: "static",
          envBindings: {
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
