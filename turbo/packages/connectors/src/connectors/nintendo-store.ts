import type { ConnectorConfig } from "../connector-config";

export const nintendoStore = {
  "nintendo-store": {
    label: "Nintendo Store",
    category: "data-automation-infrastructure",
    tags: ["gaming", "player", "nintendo", "store", "catalog", "playtime"],
    helpText:
      "Connect your Nintendo Account to access Nintendo Store catalog, wishlist, points, and play activity data.",
    authMethods: {
      api: {
        label: "Nintendo sign-in",
        helpText:
          "Sign in with Nintendo. After signing in, right-click the redirect button and copy its link address, then paste the full `npf...://auth` redirect URL or the `session_token_code` value.",
        client: {
          clientRegistration: "static",
          clientType: "public",
          clientId: "5c38e31cd085304b",
        },
        storage: {
          version: 1,
          secrets: [
            "NINTENDO_STORE_SESSION_TOKEN",
            "NINTENDO_STORE_ACCESS_TOKEN",
            "NINTENDO_STORE_ID_TOKEN",
          ],
          variables: ["NINTENDO_STORE_ACCOUNT_ID", "NINTENDO_STORE_LOCALE"],
        },
        grant: {
          kind: "external-code",
          scopes: [
            "openid",
            "user",
            "user.mii",
            "user.email",
            "user.links[].id",
          ],
          outputs: {
            sessionToken: "$secrets.NINTENDO_STORE_SESSION_TOKEN",
            accessToken: "$secrets.NINTENDO_STORE_ACCESS_TOKEN",
            idToken: "$secrets.NINTENDO_STORE_ID_TOKEN",
            accountId: "$vars.NINTENDO_STORE_ACCOUNT_ID",
            locale: "$vars.NINTENDO_STORE_LOCALE",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            sessionToken: "$secrets.NINTENDO_STORE_SESSION_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.NINTENDO_STORE_ACCESS_TOKEN",
            idToken: "$secrets.NINTENDO_STORE_ID_TOKEN",
            locale: "$vars.NINTENDO_STORE_LOCALE",
          },
          refreshableSecrets: ["NINTENDO_STORE_ACCESS_TOKEN"],
          envBindings: {
            NINTENDO_STORE_TOKEN: "$secrets.NINTENDO_STORE_ACCESS_TOKEN",
            NINTENDO_STORE_LOCALE: "$vars.NINTENDO_STORE_LOCALE",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
