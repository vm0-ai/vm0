import { FeatureSwitchKey } from "../../feature-switch-key";
import type { ConnectorConfig } from "../connectors";

export const supabase = {
  supabase: {
    label: "Supabase",
    environmentMapping: {
      SUPABASE_TOKEN: "$secrets.SUPABASE_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.SupabaseConnector,
    helpText:
      "Connect your Supabase account to manage projects, databases, and APIs",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Supabase to grant access.",
        secrets: {
          SUPABASE_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          SUPABASE_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
      "api-token": {
        label: "Service Role Key",
        helpText:
          "1. Log in to the [Supabase Dashboard](https://supabase.com/dashboard)\n2. Open your project's **Connect** dialog, or go to **Project Settings > API Keys**\n3. For legacy keys, copy the `anon` key (for client-side) or `service_role` key (for server-side) from the **Legacy API Keys** tab\n4. For new keys, open the **API Keys** tab, click **Create new API Keys** if needed, and copy the value from the **Publishable key** section",
        secrets: {
          SUPABASE_TOKEN: {
            label: "Service Role Key",
            required: true,
            placeholder: "eyJhbGci... or sb_secret_...",
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://api.supabase.com/v1/oauth/authorize",
      tokenUrl: "https://api.supabase.com/v1/oauth/token",
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
  },
} as const satisfies Record<string, ConnectorConfig>;
