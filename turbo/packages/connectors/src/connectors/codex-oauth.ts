import type { ConnectorConfig } from "../connectors";

export const codexOauth = {
  "codex-oauth": {
    label: "ChatGPT (OAuth)",
    category: "ai-general-models",
    environmentMapping: {
      CHATGPT_TOKEN: "$secrets.CHATGPT_ACCESS_TOKEN",
    },
    helpText:
      "Sign in with your ChatGPT subscription (Plus / Pro / Business / Edu / Enterprise) to use Codex agents against your ChatGPT quota.",
    authMethods: {
      oauth: {
        label: "OAuth",
        helpText: "Sign in with ChatGPT.",
        secrets: {
          CHATGPT_ACCESS_TOKEN: { label: "Access Token", required: true },
          CHATGPT_REFRESH_TOKEN: { label: "Refresh Token", required: true },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://auth.openai.com/oauth/authorize",
      tokenUrl: "https://auth.openai.com/oauth/token",
      scopes: [
        "openid",
        "profile",
        "email",
        "offline_access",
        "api.connectors.read",
        "api.connectors.invoke",
      ],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
