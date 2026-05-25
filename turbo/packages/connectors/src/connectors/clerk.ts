import type { ConnectorConfig } from "../connectors";

export const clerk = {
  clerk: {
    label: "Clerk",
    category: "engineering-team-execution",
    helpText:
      "Connect to Clerk to look up users, manage organizations and memberships, send invitations, and audit sessions across your application's identity store.",
    authMethods: {
      "api-token": {
        label: "Secret Key",
        helpText:
          "Go to Clerk Dashboard → API Keys → copy the **Secret key** (starts with `sk_test_` for development or `sk_live_` for production). The key grants full administrative access to the matching instance — vm0's firewall ships with write operations denied by default; enable `*:write` permissions per agent only when needed.",
        grant: {
          kind: "manual",
          fields: {
            CLERK_TOKEN: {
              label: "Secret Key",
              required: true,
              placeholder: "sk_live_...",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            CLERK_TOKEN: "$secrets.CLERK_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
