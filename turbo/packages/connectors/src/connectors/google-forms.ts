import type { ConnectorConfig } from "../connector-config";
import { FeatureSwitchKey } from "../feature-switch-key";

export const googleForms = {
  "google-forms": {
    label: "Google Forms",
    category: "docs-files-knowledge",
    tags: ["forms", "surveys", "questionnaires", "responses"],
    helpText:
      "Connect your Google account to create and manage forms and read responses",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.GoogleFormsConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant Google Forms access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
          clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
        },
        storage: {
          version: 1,
          secrets: ["GOOGLE_FORMS_ACCESS_TOKEN", "GOOGLE_FORMS_REFRESH_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "auth-code",
          scopes: [
            "https://www.googleapis.com/auth/forms.body",
            "https://www.googleapis.com/auth/forms.responses.readonly",
            "https://www.googleapis.com/auth/userinfo.email",
          ],
          outputs: {
            accessToken: "$secrets.GOOGLE_FORMS_ACCESS_TOKEN",
            refreshToken: "$secrets.GOOGLE_FORMS_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.GOOGLE_FORMS_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.GOOGLE_FORMS_ACCESS_TOKEN",
            refreshToken: "$secrets.GOOGLE_FORMS_REFRESH_TOKEN",
          },
          refreshableSecrets: ["GOOGLE_FORMS_ACCESS_TOKEN"],
          envBindings: {
            GOOGLE_FORMS_TOKEN: "$secrets.GOOGLE_FORMS_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
