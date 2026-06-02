import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const mailchimp = {
  mailchimp: {
    label: "Mailchimp",
    category: "communication-collaboration",
    helpText:
      "Connect your Mailchimp account to manage audiences, campaigns, templates, and automations",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.MailchimpConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Mailchimp to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "MAILCHIMP_OAUTH_CLIENT_ID",
          clientSecretEnv: "MAILCHIMP_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["MAILCHIMP_ACCESS_TOKEN"],
          variables: [],
          secretRoles: {
            accessToken: "MAILCHIMP_ACCESS_TOKEN",
          },
        },
        grant: {
          kind: "auth-code",
          tokenUrl: "https://login.mailchimp.com/oauth2/token",
          scopes: [],
        },
        access: {
          kind: "static",
          envBindings: {
            MAILCHIMP_TOKEN: "$secrets.MAILCHIMP_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Mailchimp](https://mailchimp.com)\n2. Click your **profile icon** and select **Profile**\n3. Click the **Extras** dropdown menu, then choose **API keys**\n4. In the **Your API Keys** section, click **Create A Key**\n5. Enter a descriptive name for the key\n6. Click **Generate Key**\n7. Click **Copy Key to Clipboard** and store it in a secure place (you will not be able to see or copy it again)\n8. Click **Done**",
        storage: {
          secrets: ["MAILCHIMP_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            MAILCHIMP_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-us00",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            MAILCHIMP_TOKEN: "$secrets.MAILCHIMP_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
