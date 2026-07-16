import type { ConnectorConfig } from "../connector-config";
import { FeatureSwitchKey } from "../feature-switch-key";

export const googleContacts = {
  "google-contacts": {
    label: "Google Contacts",
    category: "communication-collaboration",
    tags: ["contacts", "address-book", "people"],
    helpText:
      "Connect your Google account to access and manage contacts and contact groups",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.GoogleContactsConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant Google Contacts access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
          clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: [
            "GOOGLE_CONTACTS_ACCESS_TOKEN",
            "GOOGLE_CONTACTS_REFRESH_TOKEN",
          ],
          variables: [],
        },
        grant: {
          kind: "auth-code",
          scopes: [
            "https://www.googleapis.com/auth/contacts",
            "https://www.googleapis.com/auth/userinfo.email",
          ],
          outputs: {
            accessToken: "$secrets.GOOGLE_CONTACTS_ACCESS_TOKEN",
            refreshToken: "$secrets.GOOGLE_CONTACTS_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.GOOGLE_CONTACTS_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.GOOGLE_CONTACTS_ACCESS_TOKEN",
            refreshToken: "$secrets.GOOGLE_CONTACTS_REFRESH_TOKEN",
          },
          refreshableSecrets: ["GOOGLE_CONTACTS_ACCESS_TOKEN"],
          envBindings: {
            GOOGLE_CONTACTS_TOKEN: "$secrets.GOOGLE_CONTACTS_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
