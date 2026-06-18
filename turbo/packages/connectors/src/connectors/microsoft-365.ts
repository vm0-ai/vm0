import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const microsoft365 = {
  "microsoft-365": {
    label: "Microsoft 365",
    category: "communication-collaboration",
    helpText:
      "Connect Microsoft 365 to access OneDrive, SharePoint, Teams, and chat data through Microsoft Graph",
    tags: [
      "onedrive",
      "sharepoint",
      "teams",
      "microsoft graph",
      "files",
      "chat",
    ],
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.Microsoft365Connector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Microsoft to grant Microsoft Graph access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "MICROSOFT_OAUTH_CLIENT_ID",
          clientSecretEnv: "MICROSOFT_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: [
            "MICROSOFT_365_ACCESS_TOKEN",
            "MICROSOFT_365_REFRESH_TOKEN",
          ],
          variables: [],
        },
        grant: {
          kind: "auth-code",
          scopes: [
            "User.Read",
            "offline_access",
            "Files.ReadWrite.All",
            "Sites.ReadWrite.All",
            "Team.ReadBasic.All",
            "Channel.ReadBasic.All",
            "ChannelMessage.Read.All",
            "ChannelMessage.Send",
            "Chat.ReadWrite",
            "ChatMessage.Send",
          ],
          outputs: {
            accessToken: "$secrets.MICROSOFT_365_ACCESS_TOKEN",
            refreshToken: "$secrets.MICROSOFT_365_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.MICROSOFT_365_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.MICROSOFT_365_ACCESS_TOKEN",
            refreshToken: "$secrets.MICROSOFT_365_REFRESH_TOKEN",
          },
          refreshableSecrets: ["MICROSOFT_365_ACCESS_TOKEN"],
          envBindings: {
            MICROSOFT_365_TOKEN: "$secrets.MICROSOFT_365_ACCESS_TOKEN",
            MICROSOFT_GRAPH_TOKEN: "$secrets.MICROSOFT_365_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
