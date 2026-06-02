import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

const OAUTH_TOKEN_URL = "https://api.supabase.com/v1/oauth/token";

export const supabase = {
  supabase: {
    label: "Supabase",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Supabase account to manage projects, databases, and APIs",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.SupabaseConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Supabase to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "SUPABASE_OAUTH_CLIENT_ID",
          clientSecretEnv: "SUPABASE_OAUTH_CLIENT_SECRET",
        },
        grant: {
          kind: "auth-code",
          tokenUrl: OAUTH_TOKEN_URL,
          scopes: [
            "organizations:read",
            "projects:read",
            "projects:write",
            "database:read",
            "database:write",
            "secrets:read",
            "rest:read",
            "rest:write",
            "auth:read",
            "analytics:read",
            "environment:read",
            "domains:read",
          ],
        },
        access: {
          kind: "refresh-token",
          tokenUrl: OAUTH_TOKEN_URL,
          accessToken: "SUPABASE_ACCESS_TOKEN",
          refreshToken: "SUPABASE_REFRESH_TOKEN",
          envBindings: {
            SUPABASE_TOKEN: "$secrets.SUPABASE_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
      "api-token": {
        label: "Service Role Key",
        helpText:
          "1. Log in to the [Supabase Dashboard](https://supabase.com/dashboard)\n2. Open your project's **Connect** dialog, or go to **Project Settings > API Keys**\n3. For legacy keys, copy the `anon` key (for client-side) or `service_role` key (for server-side) from the **Legacy API Keys** tab\n4. For new keys, open the **API Keys** tab, click **Create new API Keys** if needed, and copy the value from the **Publishable key** section",
        grant: {
          kind: "manual",
          fields: {
            SUPABASE_TOKEN: {
              label: "Service Role Key",
              required: true,
              placeholder: "eyJhbGci... or sb_secret_...",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            SUPABASE_TOKEN: "$secrets.SUPABASE_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
