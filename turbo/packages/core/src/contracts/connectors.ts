import { z } from "zod";
import { FeatureSwitchKey } from "../feature-switch-key";

/**
 * Secret field configuration for connector auth methods
 */
export interface ConnectorSecretConfig {
  label: string;
  required: boolean;
  placeholder?: string;
  /** Storage type: "secret" (default, encrypted) or "variable" (plain text). */
  type?: "secret" | "variable";
}

/**
 * Auth method configuration for connectors
 */
export interface ConnectorAuthMethodConfig {
  label: string;
  helpText?: string;
  secrets: Record<string, ConnectorSecretConfig>;
}

/**
 * OAuth configuration for connectors that support OAuth flow.
 */
export interface ConnectorOAuthConfig {
  authorizationUrl?: string;
  tokenUrl: string;
  scopes: string[];
}

export type ConnectorAuthMethodType = "oauth" | "api-token" | "api";

/**
 * Base configuration shape for all connector types.
 */
export interface ConnectorConfig {
  readonly label: string;
  readonly helpText: string;
  readonly featureFlag?: FeatureSwitchKey;
  readonly authMethods: Partial<
    Record<ConnectorAuthMethodType, ConnectorAuthMethodConfig>
  >;
  readonly defaultAuthMethod?: ConnectorAuthMethodType;
  readonly oauth?: ConnectorOAuthConfig;
  /** Environment mapping declaring which env vars this connector provides. */
  readonly environmentMapping: Record<string, string>;
}

/**
 * Connector type configuration
 * Maps type to display info, auth methods, and OAuth environment mapping.
 */
const CONNECTOR_TYPES_DEF = {
  axiom: {
    label: "Axiom",
    environmentMapping: {
      AXIOM_TOKEN: "$secrets.AXIOM_TOKEN",
    },
    helpText:
      "Connect your Axiom account to query logs, manage datasets, and access observability data",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Axiom](https://app.axiom.co)\n2. Go to **Settings > API Tokens**\n3. Create a new API token with the required permissions\n4. Copy the token",
        secrets: {
          AXIOM_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "xaat-...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  ahrefs: {
    label: "Ahrefs",
    environmentMapping: {
      AHREFS_TOKEN: "$secrets.AHREFS_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.AhrefsConnector,
    helpText:
      "Connect your Ahrefs account to access SEO data, backlink analysis, and keyword research",
    authMethods: {
      oauth: {
        label: "OAuth",
        helpText: "Sign in with Ahrefs to grant access.",
        secrets: {
          AHREFS_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          AHREFS_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Ahrefs](https://ahrefs.com) as a workspace owner or admin\n2. Go to **Account settings > API keys**\n3. Create a new API key\n4. Copy the API key and use it in the `Authorization: Bearer <YOUR_API_KEY>` header",
        secrets: {
          AHREFS_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "your-ahrefs-api-token",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
    oauth: {
      authorizationUrl: "https://app.ahrefs.com/api/auth",
      tokenUrl: "https://app.ahrefs.com/api/token",
      scopes: ["api"],
    },
  },
  agentmail: {
    label: "AgentMail",
    environmentMapping: {
      AGENTMAIL_TOKEN: "$secrets.AGENTMAIL_TOKEN",
    },
    helpText:
      "Connect your AgentMail account to create email inboxes for AI agents, send and receive emails, manage threads, drafts, and webhooks",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [AgentMail Console](https://console.agentmail.to)\n2. Go to **API Keys**\n3. Create a new API key\n4. Copy the key",
        secrets: {
          AGENTMAIL_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-agentmail-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  agentphone: {
    label: "AgentPhone",
    environmentMapping: {
      AGENTPHONE_TOKEN: "$secrets.AGENTPHONE_TOKEN",
    },
    helpText:
      "Connect your AgentPhone account to make and receive phone calls, send SMS, manage phone numbers, and build voice AI agents",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign up at [agentphone.to](https://agentphone.to)\n2. Go to **Dashboard > API Keys**\n3. Create a new API key and copy it (starts with `sk_live_`)",
        secrets: {
          AGENTPHONE_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "sk_live_...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  airtable: {
    label: "Airtable",
    environmentMapping: {
      AIRTABLE_TOKEN: "$secrets.AIRTABLE_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Airtable account to access bases, tables, and records",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Airtable to grant access.",
        secrets: {
          AIRTABLE_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          AIRTABLE_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://airtable.com/oauth2/v1/authorize",
      tokenUrl: "https://airtable.com/oauth2/v1/token",
      scopes: [
        "data.records:read",
        "data.records:write",
        "data.recordComments:read",
        "data.recordComments:write",
        "schema.bases:read",
        "schema.bases:write",
        "user.email:read",
      ],
    },
  },
  "anthropic-managed-agents": {
    label: "Anthropic Managed Agents",
    environmentMapping: {
      ANTHROPIC_MANAGED_AGENTS_TOKEN: "$secrets.ANTHROPIC_MANAGED_AGENTS_TOKEN",
    },
    helpText:
      "Connect to Anthropic Managed Agents API to programmatically create and run AI agents in cloud environments",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign up at [Anthropic Console](https://console.anthropic.com)\n2. Go to **API Keys** and create a new key\n3. Ensure your account has Managed Agents (beta) access\n4. Copy the API key (starts with `sk-ant-`)",
        secrets: {
          ANTHROPIC_MANAGED_AGENTS_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "sk-ant-api03-...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  github: {
    label: "GitHub",
    environmentMapping: {
      GH_TOKEN: "$secrets.GITHUB_ACCESS_TOKEN",
      GITHUB_TOKEN: "$secrets.GITHUB_ACCESS_TOKEN",
    },
    helpText:
      "Connect your GitHub account to access repositories and GitHub features",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with GitHub to grant access.",
        secrets: {
          GITHUB_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["repo", "project", "workflow"],
    },
  },
  notion: {
    label: "Notion",
    environmentMapping: {
      NOTION_TOKEN: "$secrets.NOTION_ACCESS_TOKEN",
    },
    helpText: "Connect your Notion workspace to access pages and databases",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Notion to grant access.",
        secrets: {
          NOTION_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          NOTION_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
      tokenUrl: "https://api.notion.com/v1/oauth/token",
      scopes: [],
    },
  },
  gmail: {
    label: "Gmail",
    environmentMapping: {
      GMAIL_TOKEN: "$secrets.GMAIL_ACCESS_TOKEN",
    },
    helpText: "Connect your Gmail account to send and read emails",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant Gmail access.",
        secrets: {
          GMAIL_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          GMAIL_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    },
  },
  "google-sheets": {
    label: "Google Sheets",
    environmentMapping: {
      GOOGLE_SHEETS_TOKEN: "$secrets.GOOGLE_SHEETS_ACCESS_TOKEN",
    },
    helpText: "Connect your Google account to access and manage spreadsheets",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant Google Sheets access.",
        secrets: {
          GOOGLE_SHEETS_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          GOOGLE_SHEETS_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
    },
  },
  "google-docs": {
    label: "Google Docs",
    environmentMapping: {
      GOOGLE_DOCS_TOKEN: "$secrets.GOOGLE_DOCS_ACCESS_TOKEN",
    },
    helpText: "Connect your Google account to access and manage documents",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant Google Docs access.",
        secrets: {
          GOOGLE_DOCS_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          GOOGLE_DOCS_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: [
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
    },
  },
  "google-drive": {
    label: "Google Drive",
    environmentMapping: {
      GOOGLE_DRIVE_TOKEN: "$secrets.GOOGLE_DRIVE_ACCESS_TOKEN",
    },
    helpText: "Connect your Google account to access and manage files in Drive",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant Google Drive access.",
        secrets: {
          GOOGLE_DRIVE_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          GOOGLE_DRIVE_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
    },
  },
  "google-calendar": {
    label: "Google Calendar",
    environmentMapping: {
      GOOGLE_CALENDAR_TOKEN: "$secrets.GOOGLE_CALENDAR_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Google account to access and manage calendar events",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant Google Calendar access.",
        secrets: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          GOOGLE_CALENDAR_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: [
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
    },
  },
  "google-meet": {
    label: "Google Meet",
    environmentMapping: {
      GOOGLE_MEET_TOKEN: "$secrets.GOOGLE_MEET_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Google account to manage Meet spaces, view conference records, participants, recordings, and transcripts",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant Google Meet access.",
        secrets: {
          GOOGLE_MEET_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          GOOGLE_MEET_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: [
        "https://www.googleapis.com/auth/meetings.space.created",
        // Use meetings.space.readonly (not meetings.conferencerecords.readonly) — confirmed
        // correct per Google Discovery API. meetings.space.readonly grants read access to
        // spaces and conference records; meetings.conferencerecords.readonly is not a valid
        // OAuth scope in the Google Meet REST API v2 discovery document.
        "https://www.googleapis.com/auth/meetings.space.readonly",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
    },
  },
  close: {
    label: "Close",
    environmentMapping: {
      CLOSE_TOKEN: "$secrets.CLOSE_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.CloseConnector,
    helpText:
      "Connect your Close account to manage leads, contacts, and opportunities",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Close to grant access.",
        secrets: {
          CLOSE_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          CLOSE_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://app.close.com/oauth2/authorize/",
      tokenUrl: "https://api.close.com/oauth2/token/",
      scopes: ["all.full_access", "offline_access"],
    },
  },
  "hugging-face": {
    label: "Hugging Face",
    environmentMapping: {
      HUGGING_FACE_TOKEN: "$secrets.HUGGING_FACE_TOKEN",
    },
    helpText:
      "Connect your Hugging Face account to access models, datasets, and inference APIs",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Hugging Face](https://huggingface.co)\n2. Go to **Settings → Access Tokens**\n3. Create a new token with the required permissions\n4. Copy the token",
        secrets: {
          HUGGING_FACE_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "hf_...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  hume: {
    label: "Hume",
    environmentMapping: {
      HUME_TOKEN: "$secrets.HUME_TOKEN",
    },
    helpText:
      "Connect your Hume account to access emotion AI, speech-to-speech, and expressive text-to-speech APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to the [Hume Portal](https://app.hume.ai)\n2. Navigate to the **API Keys** page\n3. Copy your API key",
        secrets: {
          HUME_TOKEN: {
            label: "API Key",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  heygen: {
    label: "HeyGen",
    environmentMapping: {
      HEYGEN_TOKEN: "$secrets.HEYGEN_TOKEN",
    },
    helpText:
      "Connect your HeyGen account to create AI-generated videos, manage avatars, and automate video production",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [HeyGen](https://app.heygen.com)\n2. Navigate to **Settings > API > API token**\n3. Click to generate your API key\n4. Copy and save the key immediately — you cannot retrieve it after leaving the page, and regenerating a new key will invalidate the previous one",
        secrets: {
          HEYGEN_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-heygen-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  hubspot: {
    label: "HubSpot",
    environmentMapping: {
      HUBSPOT_TOKEN: "$secrets.HUBSPOT_ACCESS_TOKEN",
    },
    helpText:
      "Connect your HubSpot account to manage contacts, companies, deals, and tickets",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with HubSpot to grant access.",
        secrets: {
          HUBSPOT_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          HUBSPOT_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://app.hubspot.com/oauth/authorize",
      tokenUrl: "https://api.hubapi.com/oauth/v1/token",
      scopes: [
        "crm.objects.contacts.read",
        "crm.objects.contacts.write",
        "crm.objects.companies.read",
        "crm.objects.companies.write",
        "crm.objects.deals.read",
        "crm.objects.deals.write",
        "tickets",
        "crm.objects.line_items.read",
        "crm.objects.quotes.read",
        "crm.lists.read",
        "crm.schemas.contacts.read",
        "settings.users.read",
      ],
    },
  },
  computer: {
    label: "Computer",
    environmentMapping: {
      COMPUTER_CONNECTOR_BRIDGE_TOKEN:
        "$secrets.COMPUTER_CONNECTOR_BRIDGE_TOKEN",
      COMPUTER_CONNECTOR_DOMAIN: "$secrets.COMPUTER_CONNECTOR_DOMAIN",
    },
    featureFlag: FeatureSwitchKey.ComputerConnector,
    helpText:
      "Expose local services to remote sandboxes via authenticated ngrok tunnels",
    authMethods: {
      api: {
        label: "API",
        helpText: "Server-provisioned ngrok tunnel credentials.",
        secrets: {
          COMPUTER_CONNECTOR_BRIDGE_TOKEN: {
            label: "Bridge Token",
            required: true,
          },
          COMPUTER_CONNECTOR_DOMAIN_ID: {
            label: "Domain ID",
            required: true,
          },
          COMPUTER_CONNECTOR_DOMAIN: {
            label: "Tunnel Domain",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api",
  },
  slack: {
    label: "Slack",
    environmentMapping: {
      SLACK_TOKEN: "$secrets.SLACK_ACCESS_TOKEN",
    },
    helpText: "Connect your Slack account to send messages and read channels",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Slack to grant access.",
        secrets: {
          SLACK_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://slack.com/oauth/v2/authorize",
      tokenUrl: "https://slack.com/api/oauth.v2.access",
      // Note: Slack does not approve `search:read` or user `*:history`
      // scopes outside of RTS / MCP applications. The personal connector
      // intentionally omits them. Bot-side history access is provided
      // separately by the org install flow's SLACK_BOT_SCOPES.
      scopes: [
        // Channels
        "channels:read",
        // Messaging
        "chat:write",
        // Users
        "users:read",
        "users:read.email",
        // Files
        "files:read",
        "files:write",
        // Direct messages (high priority)
        "im:write",
        // Reactions (high priority)
        "reactions:read",
        "reactions:write",
        // Private channels (high priority)
        "groups:read",
        // Reminders (medium priority)
        "reminders:read",
        "reminders:write",
        // Pins (medium priority)
        "pins:read",
        "pins:write",
        // User groups (medium priority)
        "usergroups:read",
        // Do Not Disturb (low priority)
        "dnd:read",
        // Bookmarks (low priority)
        "bookmarks:read",
        // Team info (low priority)
        "team:read",
        // Custom emoji (low priority)
        "emoji:read",
      ],
    },
  },
  docusign: {
    label: "DocuSign",
    environmentMapping: {
      DOCUSIGN_TOKEN: "$secrets.DOCUSIGN_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.DocuSignConnector,
    helpText:
      "Connect your DocuSign account to send and manage electronic signatures",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with DocuSign to grant access.",
        secrets: {
          DOCUSIGN_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          DOCUSIGN_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://account.docusign.com/oauth/auth",
      tokenUrl: "https://account.docusign.com/oauth/token",
      scopes: ["signature", "extended", "openid"],
    },
  },
  dropbox: {
    label: "Dropbox",
    environmentMapping: {
      DROPBOX_TOKEN: "$secrets.DROPBOX_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.DropboxConnector,
    helpText: "Connect your Dropbox account to access and manage files",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Dropbox to grant access.",
        secrets: {
          DROPBOX_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          DROPBOX_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
      "api-token": {
        label: "Access Token",
        helpText:
          "1. Go to the [Dropbox App Console](https://www.dropbox.com/developers/apps)\n2. Select your app (or create a new one)\n3. Click the button to generate an access token for your own account\n4. Copy the generated OAuth 2 access token",
        secrets: {
          DROPBOX_TOKEN: {
            label: "Access Token",
            required: true,
            placeholder: "sl.xxxxxxxx",
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://www.dropbox.com/oauth2/authorize",
      tokenUrl: "https://api.dropboxapi.com/oauth2/token",
      scopes: [
        "account_info.read",
        "files.metadata.read",
        "files.content.read",
      ],
    },
  },
  linear: {
    label: "Linear",
    environmentMapping: {
      LINEAR_TOKEN: "$secrets.LINEAR_ACCESS_TOKEN",
    },
    helpText: "Connect your Linear account to manage issues and projects",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Linear to grant access.",
        secrets: {
          LINEAR_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          LINEAR_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: false,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://linear.app/oauth/authorize",
      tokenUrl: "https://api.linear.app/oauth/token",
      scopes: [
        "read",
        "write",
        "issues:create",
        "comments:create",
        "timeSchedule:write",
      ],
    },
  },
  intercom: {
    label: "Intercom",
    environmentMapping: {
      INTERCOM_TOKEN: "$secrets.INTERCOM_TOKEN",
    },
    helpText:
      "Connect your Intercom account to manage customer conversations, contacts, messages, and support tickets",
    authMethods: {
      "api-token": {
        label: "Access Token",
        helpText:
          "1. Sign up at the [Intercom Developer Hub](https://app.intercom.com/admins/sign_up/developer) on your Intercom workspace\n2. Create a new app in the Developer Hub\n3. Navigate to **Configure > Authentication** within your app in the [Developer Hub](https://app.intercom.io/a/apps/_/developer-hub/app-packages)\n4. Copy your access token",
        secrets: {
          INTERCOM_TOKEN: {
            label: "Access Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  instantly: {
    label: "Instantly",
    environmentMapping: {
      INSTANTLY_API_KEY: "$secrets.INSTANTLY_API_KEY",
    },
    helpText:
      "Connect your Instantly account to manage email campaigns, leads, and outreach sequences",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Instantly](https://app.instantly.ai)\n2. Navigate to **Settings > Integrations** at https://app.instantly.ai/app/settings/integrations\n3. Click the **API Keys** section in the left sidebar\n4. Click the **Create API Key** button\n5. Enter a name for the API key\n6. Select the scopes (permissions) you want the API key to have\n7. Click **Create**\n8. Copy the key and store it in a secure place (it will only be displayed once)",
        secrets: {
          INSTANTLY_API_KEY: {
            label: "API Key",
            required: true,
            placeholder: "your-instantly-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  jam: {
    label: "Jam",
    environmentMapping: {
      JAM_TOKEN: "$secrets.JAM_TOKEN",
    },
    helpText:
      "Connect your Jam account to capture bugs, manage reports, and access debugging telemetry",
    authMethods: {
      "api-token": {
        label: "Personal Access Token",
        helpText:
          '1. Log in to [Jam](https://jam.dev)\n2. Go to **Settings > Integrations > AI Agents**\n3. Scroll down to the **Personal Access Tokens** section\n4. Click **Create token**\n5. Enter a name for the token (e.g., "Cursor" or "Claude Code")\n6. Choose an expiration period (7 days, 30 days, 90 days, or 1 year)\n7. Select at least one scope (`mcp:read` for viewing or `mcp:write` for editing)\n8. Click **Create**\n9. Copy the token immediately (it will not be displayed again)',
        secrets: {
          JAM_TOKEN: {
            label: "Personal Access Token",
            required: true,
            placeholder: "jam_pat_...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  jira: {
    label: "Jira",
    environmentMapping: {
      JIRA_API_TOKEN: "$secrets.JIRA_API_TOKEN",
      JIRA_DOMAIN: "$vars.JIRA_DOMAIN",
      JIRA_EMAIL: "$vars.JIRA_EMAIL",
    },
    helpText:
      "Connect your Jira account to manage projects, issues, sprints, and workflows",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Go to [Atlassian API token management](https://id.atlassian.com/manage-profile/security/api-tokens)\n2. Log in to your Atlassian account\n3. Click **Create API token**\n4. Enter a name that describes what the token is for\n5. Choose an expiration date (between 1 and 365 days)\n6. Click **Create**\n7. Click **Copy to clipboard** and save the token in a secure place (you cannot recover it later)",
        secrets: {
          JIRA_API_TOKEN: {
            label: "API Token",
            required: true,
          },
          JIRA_DOMAIN: {
            label: "Jira Domain",
            required: true,
            type: "variable",
            placeholder: "your-domain.atlassian.net",
          },
          JIRA_EMAIL: {
            label: "Jira Email",
            required: true,
            type: "variable",
            placeholder: "your-email@example.com",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  jotform: {
    label: "Jotform",
    environmentMapping: {
      JOTFORM_TOKEN: "$secrets.JOTFORM_TOKEN",
    },
    helpText:
      "Connect your Jotform account to manage forms, submissions, and automate form workflows",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to your [Jotform account](https://www.jotform.com/myaccount/api)\n2. Navigate to **Settings** → **API**\n3. Click **Create New Key**\n4. Copy your **API Key**",
        secrets: {
          JOTFORM_TOKEN: {
            label: "API Key",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  kommo: {
    label: "Kommo",
    environmentMapping: {
      KOMMO_API_KEY: "$secrets.KOMMO_API_KEY",
      KOMMO_SUBDOMAIN: "$vars.KOMMO_SUBDOMAIN",
    },
    helpText:
      "Connect your Kommo account to manage leads, contacts, and sales pipelines",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Kommo](https://www.kommo.com) and create a **private integration**\n2. Go to the **Keys and Scopes** tab in your private integration settings\n3. Click **Generate long-lived token**\n4. Set the token expiration date (from 1 day to 5 years)\n5. Copy and save the token immediately (it will only be displayed once)",
        secrets: {
          KOMMO_API_KEY: {
            label: "API Key",
            required: true,
          },
          KOMMO_SUBDOMAIN: {
            label: "Subdomain",
            required: true,
            type: "variable",
            placeholder: "your-subdomain",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  line: {
    label: "LINE",
    environmentMapping: {
      LINE_TOKEN: "$secrets.LINE_TOKEN",
    },
    helpText:
      "Connect your LINE account to send messages, manage channels, and access the LINE Messaging API",
    authMethods: {
      "api-token": {
        label: "Channel Access Token",
        helpText:
          "1. Log in to the [LINE Developers Console](https://developers.line.biz/console)\n2. Select your provider and channel\n3. Go to the **Messaging API** tab\n4. Issue or copy the **Channel access token (long-lived)**",
        secrets: {
          LINE_TOKEN: {
            label: "Channel Access Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  loops: {
    label: "Loops",
    environmentMapping: {
      LOOPS_TOKEN: "$secrets.LOOPS_TOKEN",
    },
    helpText:
      "Connect your Loops account to send behavioral and transactional emails for your SaaS product",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Loops](https://app.loops.so)\n2. Go to **Settings** → **API**\n3. Click **Generate key**\n4. Copy the generated API key",
        secrets: {
          LOOPS_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "d2d561f5ff80136f69b4b5a31b9fb3c9",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  make: {
    label: "Make",
    environmentMapping: {
      MAKE_TOKEN: "$secrets.MAKE_TOKEN",
    },
    helpText:
      "Connect your Make account to manage scenarios, organizations, and automation workflows",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Make](https://www.make.com)\n2. Click your **avatar** at the bottom-left corner\n3. Select **Profile**, then open the **API** tab\n4. Click **Add token**\n5. Enter a **Label** (custom name to identify the token)\n6. Select the required **Scopes** (permissions)\n7. Click **Save**\n8. Copy the token and store it in a safe place (it will be hidden once you leave the page)",
        secrets: {
          MAKE_TOKEN: {
            label: "API Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  metabase: {
    label: "Metabase",
    environmentMapping: {
      METABASE_TOKEN: "$secrets.METABASE_TOKEN",
      METABASE_BASE_URL: "$vars.METABASE_BASE_URL",
    },
    helpText:
      "Connect your Metabase instance to query data, manage dashboards, and automate analytics workflows",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to your Metabase instance as an admin\n2. Go to **Admin** → **Settings** → **Authentication** → **API Keys**\n3. Click **Create API Key**\n4. Enter a name and select a group for the key\n5. Copy the generated API key",
        secrets: {
          METABASE_TOKEN: {
            label: "API Key",
            required: true,
          },
          METABASE_BASE_URL: {
            label: "Base URL",
            required: true,
            placeholder: "https://mycompany.metabaseapp.com",
            type: "variable",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  deel: {
    label: "Deel",
    environmentMapping: {
      DEEL_TOKEN: "$secrets.DEEL_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.DeelConnector,
    helpText:
      "Connect your Deel account to access HR, payroll, and contractor data",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Deel to grant access.",
        secrets: {
          DEEL_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          DEEL_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
      "api-token": {
        label: "API Token",
        helpText:
          "1. Create a [Deel](https://app.deel.com) account and verify your email\n2. Navigate to the **Developer Center**\n3. Select the **API Sandbox** tab (or **Production** for live credentials)\n4. Click **Create Sandbox** and enter a unique email and password\n5. Click **Confirm** to finalize sandbox creation\n6. Locate your **API Key / Access Token** in the Developer Center\n7. Copy and store the token securely",
        secrets: {
          DEEL_TOKEN: {
            label: "API Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://app.deel.com/oauth2/authorize",
      tokenUrl: "https://app.deel.com/oauth2/tokens",
      scopes: [
        "contracts:read",
        "people:read",
        "organizations:read",
        "payslips:read",
        "time-off:read",
        "time-off:write",
        "invoice-adjustments:read",
        "invoice-adjustments:write",
      ],
    },
  },
  deepseek: {
    label: "DeepSeek",
    environmentMapping: {
      DEEPSEEK_TOKEN: "$secrets.DEEPSEEK_TOKEN",
    },
    helpText:
      "Connect your DeepSeek account to use DeepSeek AI models for chat completions, code generation, and reasoning tasks",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Go to the [DeepSeek Platform](https://platform.deepseek.com/api_keys)\n2. Sign up for an account or log in\n3. Navigate to the **API Keys** page\n4. Create a new API key and copy it",
        secrets: {
          DEEPSEEK_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "sk-...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  clickup: {
    label: "ClickUp",
    environmentMapping: {
      CLICKUP_TOKEN: "$secrets.CLICKUP_TOKEN",
    },
    helpText:
      "Connect your ClickUp account to manage tasks, projects, and team workflows",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [ClickUp](https://app.clickup.com)\n2. Click your avatar in the upper-right corner and select **Settings**\n3. In the sidebar, click **Apps** (or visit [app.clickup.com/settings/apps](https://app.clickup.com/settings/apps))\n4. Under the **API Token** section, click **Generate** (or **Regenerate** if you already have one)\n5. Click **Copy** to copy the personal token (tokens start with `pk_` and never expire)",
        secrets: {
          CLICKUP_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "pk_...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  cloudflare: {
    label: "Cloudflare",
    environmentMapping: {
      CLOUDFLARE_TOKEN: "$secrets.CLOUDFLARE_TOKEN",
    },
    helpText:
      "Connect your Cloudflare account to manage DNS, zones, workers, and other Cloudflare services",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com)\n2. Go to **My Profile** → **API Tokens**\n3. Click **Create Token** and configure the required permissions\n4. Copy the generated token",
        secrets: {
          CLOUDFLARE_TOKEN: {
            label: "API Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  cloudinary: {
    label: "Cloudinary",
    environmentMapping: {
      CLOUDINARY_TOKEN: "$secrets.CLOUDINARY_TOKEN",
      CLOUDINARY_API_SECRET: "$secrets.CLOUDINARY_API_SECRET",
      CLOUDINARY_CLOUD_NAME: "$vars.CLOUDINARY_CLOUD_NAME",
    },
    helpText:
      "Connect your Cloudinary account to manage images, videos, and media assets with CDN delivery and transformations",
    authMethods: {
      "api-token": {
        label: "API Credentials",
        helpText:
          "1. Log in to the [Cloudinary Console](https://console.cloudinary.com/settings/api-keys)\n2. Go to **Settings** → **API Keys**\n3. Copy your **Cloud Name**, **API Key**, and **API Secret**",
        secrets: {
          CLOUDINARY_TOKEN: {
            label: "API Key",
            required: true,
          },
          CLOUDINARY_API_SECRET: {
            label: "API Secret",
            required: true,
          },
          CLOUDINARY_CLOUD_NAME: {
            label: "Cloud Name",
            required: true,
            type: "variable",
            placeholder: "your-cloud-name",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  cronlytic: {
    label: "Cronlytic",
    environmentMapping: {
      CRONLYTIC_API_KEY: "$secrets.CRONLYTIC_API_KEY",
      CRONLYTIC_USER_ID: "$vars.CRONLYTIC_USER_ID",
    },
    helpText:
      "Connect your Cronlytic account to monitor cron jobs and scheduled tasks",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to the [Cronlytic dashboard](https://www.cronlytic.com/dashboard)\n2. Go to the **API Keys** section\n3. Click **Generate New API Key**\n4. Copy your **API Key** and **User ID** (both are required for authentication via `X-API-Key` and `X-User-ID` headers)",
        secrets: {
          CRONLYTIC_API_KEY: {
            label: "API Key",
            required: true,
          },
          CRONLYTIC_USER_ID: {
            label: "User ID",
            required: true,
            type: "variable",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  "customer-io": {
    label: "Customer.io",
    environmentMapping: {
      CUSTOMERIO_APP_TOKEN: "$secrets.CUSTOMERIO_APP_TOKEN",
    },
    helpText:
      "Connect your Customer.io account to send behavioral emails, SMS, and push notifications triggered by user events",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to your [Customer.io](https://fly.customer.io) account\n2. Go to **Account Settings > [API Credentials](https://fly.customer.io/settings/api_credentials)**\n3. Locate your **Site ID** and **API Key** on the Track API Keys page\n4. Copy both values (they are used together as basic authentication credentials in the format `site_id:api_key`, Base64-encoded)",
        secrets: {
          CUSTOMERIO_APP_TOKEN: {
            label: "App API Key",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  dify: {
    label: "Dify",
    environmentMapping: {
      DIFY_TOKEN: "$secrets.DIFY_TOKEN",
    },
    helpText:
      "Connect your Dify account to build and manage AI-powered workflows, chatbots, and agentic applications",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Dify](https://cloud.dify.ai)\n2. Open your app and navigate to **API Access** in the left sidebar\n3. Click to generate new API credentials\n4. Copy the API key",
        secrets: {
          DIFY_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "app-...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  figma: {
    label: "Figma",
    environmentMapping: {
      FIGMA_TOKEN: "$secrets.FIGMA_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.FigmaConnector,
    helpText: "Connect your Figma account to access design files and projects",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Figma to grant access.",
        secrets: {
          FIGMA_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          FIGMA_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
      "api-token": {
        label: "Personal Access Token",
        helpText:
          "1. Log in to [Figma](https://www.figma.com) and open the file browser\n2. Click the account menu in the top-left corner and select **Settings**\n3. Select the **Security** tab\n4. Scroll to the **Personal access tokens** section and click **Generate new token**\n5. Enter a name for the token, assign the desired scopes, and press Return/Enter\n6. Copy the generated token immediately — it will not be shown again",
        secrets: {
          FIGMA_TOKEN: {
            label: "Personal Access Token",
            required: true,
            placeholder: "figd_xxxxxxxx",
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://www.figma.com/oauth",
      tokenUrl: "https://api.figma.com/v1/oauth/token",
      scopes: [
        "current_user:read",
        "file_content:read",
        "file_metadata:read",
        "file_versions:read",
        "projects:read",
        "file_comments:read",
        "file_comments:write",
        "library_assets:read",
        "library_content:read",
      ],
    },
  },
  mercury: {
    label: "Mercury",
    environmentMapping: {
      MERCURY_TOKEN: "$secrets.MERCURY_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.MercuryConnector,
    helpText:
      "Connect your Mercury account to access banking and financial data",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Mercury to grant access.",
        secrets: {
          MERCURY_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          MERCURY_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to your [Mercury Dashboard](https://mercury.com)\n2. Go to **Settings → Tokens**\n3. Generate a new API token\n4. Copy the token",
        secrets: {
          MERCURY_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "secret-token:mercury_production_...",
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://oauth2.mercury.com/oauth2/auth",
      tokenUrl: "https://oauth2.mercury.com/oauth2/token",
      scopes: ["offline_access"],
    },
  },
  minimax: {
    label: "MiniMax",
    environmentMapping: {
      MINIMAX_TOKEN: "$secrets.MINIMAX_TOKEN",
    },
    helpText:
      "Connect your MiniMax account to access AI model APIs for text, voice, and video generation",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [MiniMax Platform](https://platform.minimax.io)\n2. Go to **User Center > Basic Information > Interface Key**\n3. Create a new API key\n4. Copy the key",
        secrets: {
          MINIMAX_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-minimax-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  reportei: {
    label: "Reportei",
    environmentMapping: {
      REPORTEI_TOKEN: "$secrets.REPORTEI_TOKEN",
    },
    helpText:
      "Connect your Reportei account to generate and manage marketing reports with automated analytics",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Reportei](https://app.reportei.com)\n2. Go to **Company Settings** (Configurações da Empresa)\n3. Navigate to the **API Reportei** section\n4. Click **Generate new token** or copy your existing token",
        secrets: {
          REPORTEI_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "your-reportei-api-token",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  serpapi: {
    label: "SerpApi",
    environmentMapping: {
      SERPAPI_TOKEN: "$secrets.SERPAPI_TOKEN",
    },
    helpText:
      "Connect your SerpApi account to search Google, Bing, YouTube and other search engines programmatically",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Go to [SerpApi](https://serpapi.com) and sign up for an account (free plan available with 250 searches/month)\n2. Log in and go to your [Dashboard](https://serpapi.com/dashboard)\n3. Your API key is displayed on the dashboard\n4. Copy the API key",
        secrets: {
          SERPAPI_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-serpapi-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  salesforce: {
    label: "Salesforce",
    environmentMapping: {
      SALESFORCE_TOKEN: "$secrets.SALESFORCE_TOKEN",
      SALESFORCE_INSTANCE: "$vars.SALESFORCE_INSTANCE",
    },
    helpText:
      "Connect your Salesforce account to manage CRM data, contacts, leads, and sales workflows",
    authMethods: {
      "api-token": {
        label: "API Token",
        secrets: {
          SALESFORCE_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "00D...",
          },
          SALESFORCE_INSTANCE: {
            label: "Instance",
            required: true,
            placeholder: "mycompany",
            type: "variable",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  reddit: {
    label: "Reddit",
    environmentMapping: {
      REDDIT_TOKEN: "$secrets.REDDIT_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.RedditConnector,
    helpText:
      "Connect your Reddit account to access Reddit discussions and content",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Reddit to grant access.",
        secrets: {
          REDDIT_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          REDDIT_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://www.reddit.com/api/v1/authorize",
      tokenUrl: "https://www.reddit.com/api/v1/access_token",
      scopes: ["identity", "read"],
    },
  },
  strava: {
    label: "Strava",
    environmentMapping: {
      STRAVA_TOKEN: "$secrets.STRAVA_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Strava account to access activities and athlete data",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Strava to grant access.",
        secrets: {
          STRAVA_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          STRAVA_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://www.strava.com/oauth/authorize",
      tokenUrl: "https://www.strava.com/oauth/token",
      scopes: [
        "read",
        "profile:read_all",
        "activity:read_all",
        "activity:write",
      ],
    },
  },
  x: {
    label: "X",
    environmentMapping: {
      X_TOKEN: "$secrets.X_ACCESS_TOKEN",
    },
    helpText:
      "Connect your X (Twitter) account to read tweets, timelines, and search",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with X to grant read access.",
        secrets: {
          X_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          X_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://twitter.com/i/oauth2/authorize",
      tokenUrl: "https://api.twitter.com/2/oauth2/token",
      // https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
      scopes: [
        "tweet.read", // All the Tweets you can view, including Tweets from protected accounts.
        "tweet.write", // Tweet and Retweet for you.
        "tweet.moderate.write", // Hide and unhide replies to your Tweets.
        "users.email", // Email from an authenticated user.
        "users.read", // Any account you can view, including protected accounts.
        "follows.read", // People who follow you and people who you follow.
        "follows.write", // Follow and unfollow people for you.
        "offline.access", // Stay connected to your account until you revoke access.
        "space.read", // All the Spaces you can view.
        "mute.read", // Accounts you've muted.
        "mute.write", // Mute and unmute accounts for you.
        "like.read", // Tweets you've liked and likes you can view.
        "like.write", // Like and un-like Tweets for you.
        "list.read", // Lists, list members, and list followers of lists you've created or are a member of, including private lists.
        "list.write", // Create and manage Lists for you.
        "block.read", // Accounts you've blocked.
        "block.write", // Block and unblock accounts for you.
        "bookmark.read", // Get Bookmarked Tweets from an authenticated user.
        "bookmark.write", // Bookmark and remove Bookmarks from Tweets.
        "dm.read", // All the Direct Messages you can view, including Direct Messages from protected accounts.
        "dm.write", // Send and manage Direct Messages for you.
        "media.write", // Upload media.
      ],
    },
  },
  neon: {
    label: "Neon",
    environmentMapping: {
      NEON_TOKEN: "$secrets.NEON_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.NeonConnector,
    helpText:
      "Connect your Neon account to manage serverless Postgres databases and projects",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Neon to grant access.",
        secrets: {
          NEON_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          NEON_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Neon Console](https://console.neon.tech)\n2. Navigate to **Account settings > API keys**\n3. Click the button to create a new API key\n4. Copy and store the secret token immediately (it is only displayed once)",
        secrets: {
          NEON_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "napi_xxxxxxxx",
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://oauth2.neon.tech/oauth2/auth",
      tokenUrl: "https://oauth2.neon.tech/oauth2/token",
      scopes: [
        "openid",
        "offline_access",
        "urn:neoncloud:projects:read",
        "urn:neoncloud:projects:create",
        "urn:neoncloud:projects:update",
        "urn:neoncloud:projects:delete",
      ],
    },
  },
  gamma: {
    label: "Gamma",
    environmentMapping: {
      GAMMA_TOKEN: "$secrets.GAMMA_TOKEN",
    },
    helpText:
      "Connect your Gamma account to generate presentations, documents, and websites with AI",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Gamma](https://gamma.app)\n2. Go to [API Keys](https://gamma.app/settings/api-keys) (Settings > API Keys)\n3. Click **Create API key**\n4. Copy the key (it is only shown once)",
        secrets: {
          GAMMA_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "sk-gamma-...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  "garmin-connect": {
    label: "Garmin Connect",
    environmentMapping: {
      GARMIN_CONNECT_TOKEN: "$secrets.GARMIN_CONNECT_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.GarminConnectConnector,
    helpText:
      "Connect your Garmin Connect account to access wellness and activity data",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Garmin Connect to grant access.",
        secrets: {
          GARMIN_CONNECT_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          GARMIN_CONNECT_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://connect.garmin.com/oauth2Confirm",
      tokenUrl: "https://diauth.garmin.com/di-oauth2-service/oauth/token",
      scopes: [],
    },
  },
  vercel: {
    label: "Vercel",
    environmentMapping: {
      VERCEL_TOKEN: "$secrets.VERCEL_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Vercel account to manage deployments, projects, and domains",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Vercel to grant access.",
        secrets: {
          VERCEL_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      tokenUrl: "https://api.vercel.com/v2/oauth/access_token",
      scopes: [],
    },
  },
  sentry: {
    label: "Sentry",
    environmentMapping: {
      SENTRY_TOKEN: "$secrets.SENTRY_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Sentry account to access error tracking and project data",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Sentry to grant access.",
        secrets: {
          SENTRY_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          SENTRY_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://sentry.io/oauth/authorize/",
      tokenUrl: "https://sentry.io/oauth/token/",
      scopes: [
        "org:read",
        "project:read",
        "team:read",
        "member:read",
        "event:read",
        "event:write",
      ],
    },
  },
  posthog: {
    label: "PostHog",
    environmentMapping: {
      POSTHOG_TOKEN: "$secrets.POSTHOG_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.PosthogConnector,
    helpText:
      "Connect your PostHog account to access product analytics, feature flags, and experiments",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with PostHog to grant access.",
        secrets: {
          POSTHOG_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          POSTHOG_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
      "api-token": {
        label: "Personal API Key",
        helpText:
          "1. Log in to [PostHog](https://app.posthog.com)\n2. Navigate to **Personal API keys** in your account settings\n3. Click **+ Create a personal API Key**\n4. Enter a descriptive label for the key\n5. Choose the scopes (permissions) required for your use case\n6. Copy the key immediately (it will not be shown again after refreshing the page)",
        secrets: {
          POSTHOG_TOKEN: {
            label: "Personal API Key",
            required: true,
            placeholder: "phx_...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
    oauth: {
      authorizationUrl: "https://us.posthog.com/oauth/authorize",
      tokenUrl: "https://us.posthog.com/oauth/token",
      scopes: [
        "openid",
        "profile",
        "email",
        "user:read",
        "project:read",
        "feature_flag:read",
        "feature_flag:write",
        "experiment:read",
        "experiment:write",
        "insight:read",
        "insight:write",
        "dashboard:read",
        "dashboard:write",
        "action:read",
        "action:write",
        "annotation:read",
        "annotation:write",
        "cohort:read",
        "cohort:write",
        "event_definition:read",
        "query:read",
        "survey:read",
        "survey:write",
        "error_tracking:read",
      ],
    },
  },
  productlane: {
    label: "Productlane",
    environmentMapping: {
      PRODUCTLANE_TOKEN: "$secrets.PRODUCTLANE_TOKEN",
    },
    helpText:
      "Connect your Productlane account to manage feedback, insights, changelogs, and customer data",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          PRODUCTLANE_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-productlane-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  "intervals-icu": {
    label: "Intervals.icu",
    environmentMapping: {
      INTERVALS_ICU_TOKEN: "$secrets.INTERVALS_ICU_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Intervals.icu account to access training, activity, wellness, and calendar data",
    authMethods: {
      oauth: {
        label: "OAuth",
        helpText: "Sign in with Intervals.icu to grant access.",
        secrets: {
          INTERVALS_ICU_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://intervals.icu/oauth/authorize",
      tokenUrl: "https://intervals.icu/api/oauth/token",
      scopes: ["ACTIVITY", "WELLNESS", "CALENDAR", "SETTINGS", "LIBRARY"],
    },
  },
  monday: {
    label: "Monday.com",
    environmentMapping: {
      MONDAY_TOKEN: "$secrets.MONDAY_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Monday.com account to manage boards, items, and workflows",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Monday.com to grant access.",
        secrets: {
          MONDAY_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          MONDAY_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://auth.monday.com/oauth2/authorize",
      tokenUrl: "https://auth.monday.com/oauth2/token",
      scopes: [
        "me:read",
        "boards:read",
        "boards:write",
        "docs:read",
        "docs:write",
        "workspaces:read",
        "users:read",
        "account:read",
        "updates:read",
        "updates:write",
        "notifications:write",
        "assets:read",
        "tags:read",
        "teams:read",
      ],
    },
  },
  calendly: {
    label: "Calendly",
    environmentMapping: {
      CALENDLY_TOKEN: "$secrets.CALENDLY_TOKEN",
    },
    helpText:
      "Connect your Calendly account to access scheduling data, event types, and invitee information",
    authMethods: {
      "api-token": {
        label: "Personal Access Token",
        helpText:
          "1. Log in to [Calendly](https://calendly.com)\n2. Go to **Integrations > API & Webhooks**\n3. Generate a Personal Access Token\n4. Copy the token",
        secrets: {
          CALENDLY_TOKEN: {
            label: "Personal Access Token",
            required: true,
            placeholder: "your-calendly-token",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  canva: {
    label: "Canva",
    environmentMapping: {
      CANVA_TOKEN: "$secrets.CANVA_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.CanvaConnector,
    helpText:
      "Connect your Canva account to access designs, assets, and projects",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Canva to grant access.",
        secrets: {
          CANVA_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          CANVA_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://www.canva.com/api/oauth/authorize",
      tokenUrl: "https://api.canva.com/rest/v1/oauth/token",
      scopes: [
        "asset:read",
        "asset:write",
        "brandtemplate:content:read",
        "brandtemplate:meta:read",
        "comment:read",
        "comment:write",
        "design:content:read",
        "design:content:write",
        "design:meta:read",
        "folder:read",
        "folder:write",
        "profile:read",
      ],
    },
  },
  "cal-com": {
    label: "Cal.com",
    environmentMapping: {
      CALCOM_TOKEN: "$secrets.CALCOM_TOKEN",
    },
    helpText:
      "Connect your Cal.com account to manage scheduling, bookings, and calendar events",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Cal.com](https://app.cal.com)\n2. Go to **Settings** → **Developer** → **API Keys**\n3. Click **Create API Key**\n4. Copy the generated key",
        secrets: {
          CALCOM_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "cal_live_xxxxxxxx",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  xero: {
    label: "Xero",
    environmentMapping: {
      XERO_TOKEN: "$secrets.XERO_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Xero account to access accounting data, invoices, and contacts",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Xero to grant access.",
        secrets: {
          XERO_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          XERO_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://login.xero.com/identity/connect/authorize",
      tokenUrl: "https://identity.xero.com/connect/token",
      scopes: [
        "openid",
        "profile",
        "email",
        "offline_access",
        "accounting.contacts",
        "accounting.settings",
        "accounting.invoices",
        "accounting.payments",
        "accounting.banktransactions",
        "accounting.manualjournals",
        "accounting.attachments",
        "accounting.budgets.read",
        "accounting.reports.profitandloss.read",
        "accounting.reports.balancesheet.read",
        "accounting.reports.trialbalance.read",
        "accounting.reports.aged.read",
        "accounting.reports.executivesummary.read",
        "accounting.reports.banksummary.read",
        "accounting.reports.budgetsummary.read",
        "files",
        "assets",
        "projects",
      ],
    },
  },
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
  todoist: {
    label: "Todoist",
    environmentMapping: {
      TODOIST_TOKEN: "$secrets.TODOIST_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Todoist account to manage tasks, projects, labels, and comments",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Todoist to grant access.",
        secrets: {
          TODOIST_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://todoist.com/oauth/authorize",
      tokenUrl: "https://todoist.com/oauth/access_token",
      scopes: ["data:read_write", "data:delete", "project:delete"],
    },
  },
  webflow: {
    label: "Webflow",
    environmentMapping: {
      WEBFLOW_TOKEN: "$secrets.WEBFLOW_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.WebflowConnector,
    helpText:
      "Connect your Webflow account to manage sites, pages, CMS collections, and ecommerce",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Webflow to grant access.",
        secrets: {
          WEBFLOW_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
        },
      },
      "api-token": {
        label: "Site Token",
        helpText:
          "1. Log in to [Webflow](https://webflow.com) (site administrator access required)\n2. In your workspace, find the site and click the gear icon to open **Site Settings**\n3. In the left sidebar, select **Apps & integrations**\n4. Scroll to the bottom of the page to the **API access** section\n5. Click **Generate API token**\n6. Enter a name for your token and choose the required scopes\n7. Click **Generate token**\n8. Copy the generated token and save it in a secure location",
        secrets: {
          WEBFLOW_TOKEN: {
            label: "Site Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://webflow.com/oauth/authorize",
      tokenUrl: "https://api.webflow.com/oauth/access_token",
      scopes: [
        "authorized_user:read",
        "sites:read",
        "sites:write",
        "pages:read",
        "pages:write",
        "cms:read",
        "cms:write",
        "assets:read",
        "assets:write",
        "forms:read",
        "ecommerce:read",
        "ecommerce:write",
        "users:read",
        "workspace:read",
        "custom_code:read",
        "custom_code:write",
      ],
    },
  },
  wrike: {
    label: "Wrike",
    environmentMapping: {
      WRIKE_TOKEN: "$secrets.WRIKE_TOKEN",
    },
    helpText:
      "Connect your Wrike account to manage projects, tasks, folders, and workflows",
    authMethods: {
      "api-token": {
        label: "Permanent Access Token",
        helpText:
          "1. Navigate to your [Wrike](https://www.wrike.com) workspace\n2. Click on your **profile icon** in the navigation bar\n3. Select **Apps & Integrations**\n4. Click on **API**\n5. Click **+ App**\n6. Enter a name for your integration\n7. Click **Get Token** at the bottom of the window\n8. Copy and securely store your token — it will not be shown again after closing the page\n9. Click **Save**",
        secrets: {
          WRIKE_TOKEN: {
            label: "Permanent Access Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  "outlook-mail": {
    label: "Outlook Mail",
    environmentMapping: {
      OUTLOOK_MAIL_TOKEN: "$secrets.OUTLOOK_MAIL_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.OutlookMailConnector,
    helpText: "Connect your Microsoft Outlook account to send and read emails",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Microsoft to grant Outlook Mail access.",
        secrets: {
          OUTLOOK_MAIL_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          OUTLOOK_MAIL_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl:
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      scopes: ["Mail.ReadWrite", "Mail.Send", "User.Read", "offline_access"],
    },
  },
  "outlook-calendar": {
    label: "Outlook Calendar",
    environmentMapping: {
      OUTLOOK_CALENDAR_TOKEN: "$secrets.OUTLOOK_CALENDAR_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.OutlookCalendarConnector,
    helpText:
      "Connect your Microsoft account to access and manage Outlook calendar events",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Microsoft to grant Outlook Calendar access.",
        secrets: {
          OUTLOOK_CALENDAR_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          OUTLOOK_CALENDAR_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl:
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      scopes: ["Calendars.ReadWrite", "User.Read", "offline_access"],
    },
  },
  asana: {
    label: "Asana",
    environmentMapping: {
      ASANA_TOKEN: "$secrets.ASANA_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Asana account to manage tasks, projects, portfolios, goals, and team workflows",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Asana to grant access.",
        secrets: {
          ASANA_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          ASANA_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://app.asana.com/-/oauth_authorize",
      tokenUrl: "https://app.asana.com/-/oauth_token",
      scopes: [],
    },
  },
  atlassian: {
    label: "Atlassian (Jira/Confluence)",
    environmentMapping: {
      ATLASSIAN_TOKEN: "$secrets.ATLASSIAN_TOKEN",
      ATLASSIAN_EMAIL: "$vars.ATLASSIAN_EMAIL",
      ATLASSIAN_DOMAIN: "$vars.ATLASSIAN_DOMAIN",
    },
    helpText:
      "Connect your Atlassian account to manage Jira issues, Confluence pages, and other Atlassian products",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Atlassian](https://id.atlassian.com/manage-profile/security/api-tokens)\n2. Click **Create API token**\n3. Give it a label and click **Create**\n4. Copy the generated token",
        secrets: {
          ATLASSIAN_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "your-api-token",
          },
          ATLASSIAN_EMAIL: {
            label: "Email",
            required: true,
            placeholder: "you@example.com",
            type: "variable",
          },
          ATLASSIAN_DOMAIN: {
            label: "Domain",
            required: true,
            placeholder: "mycompany",
            type: "variable",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  "meta-ads": {
    label: "Meta Ads",
    environmentMapping: {
      META_ADS_TOKEN: "$secrets.META_ADS_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.MetaAdsConnector,
    helpText:
      "Connect your Meta Ads Manager account to manage ad campaigns, audiences, and insights",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Facebook to grant access to Ads Manager.",
        secrets: {
          META_ADS_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://www.facebook.com/v22.0/dialog/oauth",
      tokenUrl: "https://graph.facebook.com/v22.0/oauth/access_token",
      scopes: ["ads_management", "ads_read", "business_management"],
    },
  },
  stripe: {
    label: "Stripe",
    environmentMapping: {
      STRIPE_TOKEN: "$secrets.STRIPE_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.StripeConnector,
    helpText:
      "Connect your Stripe account to manage payments, customers, and subscriptions",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Stripe to grant access.",
        secrets: {
          STRIPE_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          STRIPE_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: false,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://connect.stripe.com/oauth/authorize",
      tokenUrl: "https://connect.stripe.com/oauth/token",
      scopes: ["read_write"],
    },
  },
  openai: {
    label: "OpenAI",
    environmentMapping: {
      OPENAI_TOKEN: "$secrets.OPENAI_TOKEN",
    },
    helpText:
      "Connect your OpenAI account to access GPT models, embeddings, image generation, and other AI capabilities",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [OpenAI Platform](https://platform.openai.com)\n2. Navigate to the [API Keys](https://platform.openai.com/api-keys) page in the dashboard\n3. Create a new API key\n4. Copy and store the key in a safe location",
        secrets: {
          OPENAI_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "sk-...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  similarweb: {
    label: "SimilarWeb",
    environmentMapping: {
      SIMILARWEB_TOKEN: "$secrets.SIMILARWEB_TOKEN",
    },
    helpText:
      "Connect your SimilarWeb account to access website traffic analytics, competitive intelligence, and market insights",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to the [Similarweb platform](https://pro.similarweb.com/) (admin access required)\n2. From the main menu on the left, select **Settings & Help**, then select **Account**\n3. Under **Data Tools**, select either **REST API** or **Batch API**\n4. Click **Generate a New API Key** on the right\n5. Type the name of the API key, then select whether this is for yourself or another user\n6. Click **Create** — your key will be displayed in the Generated Keys table\n7. In the Generated Keys table, ensure the **Activation** toggle is on for the relevant API key",
        secrets: {
          SIMILARWEB_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-similarweb-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  perplexity: {
    label: "Perplexity",
    environmentMapping: {
      PERPLEXITY_TOKEN: "$secrets.PERPLEXITY_TOKEN",
    },
    helpText:
      "Connect your Perplexity account to access AI-powered search and research capabilities via the Sonar API",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          '1. Log in to the [Perplexity Console](https://console.perplexity.ai)\n2. Navigate to the **API Groups** page and create an API group (e.g., "Production" or "Development")\n3. Go to the **API Keys** page\n4. Generate a new API key\n5. Store the key immediately and securely (you will only see the full token value once)',
        secrets: {
          PERPLEXITY_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "pplx-...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  plain: {
    label: "Plain",
    environmentMapping: {
      PLAIN_TOKEN: "$secrets.PLAIN_TOKEN",
    },
    helpText:
      "Connect your Plain account to manage customer support threads, customers, and labels via Plain's GraphQL API",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Plain](https://app.plain.com)\n2. Go to **Settings → Machine Users**\n3. Click **New machine user** and generate an API key\n4. Copy the API key",
        secrets: {
          PLAIN_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "plainApiKey__...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  plausible: {
    label: "Plausible",
    environmentMapping: {
      PLAUSIBLE_TOKEN: "$secrets.PLAUSIBLE_TOKEN",
    },
    helpText:
      "Connect your Plausible Analytics account to access website traffic analytics, visitor stats, and site management",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Plausible Analytics](https://plausible.io)\n2. Go to **Account Settings** → **API Keys**\n3. Click **New API Key** and choose **Stats API**\n4. Copy the key (it is only shown once)",
        secrets: {
          PLAUSIBLE_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-plausible-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  mailchimp: {
    label: "Mailchimp",
    environmentMapping: {
      MAILCHIMP_TOKEN: "$secrets.MAILCHIMP_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.MailchimpConnector,
    helpText:
      "Connect your Mailchimp account to manage audiences, campaigns, templates, and automations",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Mailchimp to grant access.",
        secrets: {
          MAILCHIMP_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
        },
      },
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Mailchimp](https://mailchimp.com)\n2. Click your **profile icon** and select **Profile**\n3. Click the **Extras** dropdown menu, then choose **API keys**\n4. In the **Your API Keys** section, click **Create A Key**\n5. Enter a descriptive name for the key\n6. Click **Generate Key**\n7. Click **Copy Key to Clipboard** and store it in a secure place (you will not be able to see or copy it again)\n8. Click **Done**",
        secrets: {
          MAILCHIMP_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-us00",
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://login.mailchimp.com/oauth2/authorize",
      tokenUrl: "https://login.mailchimp.com/oauth2/token",
      scopes: [],
    },
  },
  chatwoot: {
    label: "Chatwoot",
    environmentMapping: {
      CHATWOOT_TOKEN: "$secrets.CHATWOOT_TOKEN",
    },
    helpText:
      "Connect your Chatwoot account to manage conversations, contacts, and customer support workflows",
    authMethods: {
      "api-token": {
        label: "API Access Token",
        helpText:
          "1. Log in to [Chatwoot](https://app.chatwoot.com) with an administrator account\n2. Click on your **avatar image** in the bottom left corner of the screen\n3. Select **Profile Settings** from the menu\n4. Scroll to the bottom of the Profile Settings page\n5. Copy the **Personal Access Token** displayed there",
        secrets: {
          CHATWOOT_TOKEN: {
            label: "API Access Token",
            required: true,
            placeholder: "your-chatwoot-access-token",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  resend: {
    label: "Resend",
    environmentMapping: {
      RESEND_TOKEN: "$secrets.RESEND_TOKEN",
    },
    featureFlag: FeatureSwitchKey.ResendConnector,
    helpText:
      "Connect your Resend account to send transactional emails, manage domains, audiences, and contacts",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Resend](https://resend.com)\n2. Navigate to the [API Keys](https://resend.com/api-keys) page\n3. Click **Create API Key**\n4. Enter a name for your key (up to 50 characters)\n5. Select the permission level: **Full access** or **Sending access**\n6. If choosing sending access, select which domain the key can access\n7. Copy the generated API key",
        secrets: {
          RESEND_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "re_xxxxxxxxxx",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  revenuecat: {
    label: "RevenueCat",
    environmentMapping: {
      REVENUECAT_TOKEN: "$secrets.REVENUECAT_TOKEN",
    },
    helpText:
      "Connect your RevenueCat account to manage in-app subscriptions, purchases, and customer data",
    authMethods: {
      "api-token": {
        label: "Secret API Key",
        helpText:
          "1. Log in to [RevenueCat](https://app.revenuecat.com)\n2. Navigate to the **API keys** section in your project dashboard\n3. Public API keys are automatically created when you add an app to your project\n4. To create a secret API key, click **+ New secret API key** in the API keys section\n5. Copy and store the key securely (never embed secret keys in client-side code)",
        secrets: {
          REVENUECAT_TOKEN: {
            label: "Secret API Key",
            required: true,
            placeholder: "sk_xxxxxxxxxxxxxxxx",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  pdf4me: {
    label: "PDF4me",
    environmentMapping: {
      PDF4ME_TOKEN: "$secrets.PDF4ME_TOKEN",
    },
    helpText:
      "Connect your PDF4me account to convert, merge, split, compress, and manipulate PDF documents",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Register for an account at [PDF4me](https://portal.pdf4me.com) using email/password or via Google, Microsoft, Apple, or Facebook\n2. Go to the **Billing Info** section and select **Start Free Trial**\n3. After activation, you will be redirected to the **Dashboard**\n4. Find and copy your API Key from the Dashboard",
        secrets: {
          PDF4ME_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-pdf4me-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  apify: {
    label: "Apify",
    environmentMapping: {
      APIFY_TOKEN: "$secrets.APIFY_TOKEN",
    },
    helpText:
      "Connect your Apify account to run web scraping actors, manage datasets, and automate browser tasks",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Apify Console](https://console.apify.com)\n2. Go to **Settings > Integrations**\n3. Copy your **Personal API token**",
        secrets: {
          APIFY_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "apify_api_xxxxxxxx",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  doppler: {
    label: "Doppler",
    environmentMapping: {
      DOPPLER_TOKEN: "$secrets.DOPPLER_TOKEN",
    },
    helpText:
      "Connect your Doppler account to fetch secrets and environment variables from your projects and configs",
    authMethods: {
      "api-token": {
        label: "Service Token",
        helpText:
          "1. Log in to [Doppler](https://dashboard.doppler.com)\n2. Go to your project, then select a config (environment)\n3. Click the **Access** tab\n4. Click **+ Generate Service Token**\n5. Set permissions to **Read** and copy the token",
        secrets: {
          DOPPLER_TOKEN: {
            label: "Service Token",
            required: true,
            placeholder: "dp.st.dev.xxxx",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  infisical: {
    label: "Infisical",
    environmentMapping: {
      INFISICAL_CLIENT_ID: "$secrets.INFISICAL_CLIENT_ID",
      INFISICAL_CLIENT_SECRET: "$secrets.INFISICAL_CLIENT_SECRET",
    },
    helpText:
      "Connect your Infisical account to fetch secrets from your projects and environments using Machine Identity credentials",
    authMethods: {
      "api-token": {
        label: "Machine Identity",
        helpText:
          "1. Log in to [Infisical](https://app.infisical.com)\n2. Go to **Access Control > Machine Identities**\n3. Create a new Machine Identity with **Universal Auth**\n4. Copy the **Client ID** and **Client Secret**\n5. Assign the identity to your project with the desired role",
        secrets: {
          INFISICAL_CLIENT_ID: {
            label: "Client ID",
            required: true,
            placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
          },
          INFISICAL_CLIENT_SECRET: {
            label: "Client Secret",
            required: true,
            placeholder: "your-client-secret",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  apollo: {
    label: "Apollo",
    environmentMapping: {
      APOLLO_TOKEN: "$secrets.APOLLO_TOKEN",
    },
    helpText:
      "Connect your Apollo account to search prospects, enrich contacts, manage accounts, deals, sequences, and more",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Apollo](https://app.apollo.io)\n2. Go to **Settings > Integrations**\n3. Click **Connect** beside Apollo API\n4. Select **API Keys > Create new key**\n5. Enter a name, select endpoint access (or toggle **Set as master key**)\n6. Copy the API key",
        secrets: {
          APOLLO_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-apollo-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  pika: {
    label: "Pika",
    environmentMapping: {
      PIKA_TOKEN: "$secrets.PIKA_TOKEN",
    },
    helpText:
      "Connect your Pika Developer account to join video meetings (Google Meet, Zoom) as a real-time AI avatar with voice cloning",
    authMethods: {
      "api-token": {
        label: "Developer Key",
        helpText:
          "1. Go to [pika.me/dev](https://www.pika.me/dev/)\n2. Sign in or create an account\n3. Create a new Developer Key\n4. Copy the key (format: `dk_...`)",
        secrets: {
          PIKA_TOKEN: {
            label: "Developer Key",
            required: true,
            placeholder: "dk_...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  bitrix: {
    label: "Bitrix24",
    environmentMapping: {
      BITRIX_WEBHOOK_URL: "$secrets.BITRIX_WEBHOOK_URL",
    },
    helpText:
      "Connect your Bitrix24 account to manage CRM, tasks, and workflows",
    authMethods: {
      "api-token": {
        label: "Webhook URL",
        helpText:
          "1. Log in to your [Bitrix24](https://www.bitrix24.com) account\n2. Go to **Applications > Developer resources**\n3. Select the **Ready-made scenarios** tab\n4. Choose **Other > Incoming webhook**\n5. Configure the webhook name and set access permissions\n6. Click **Execute** to test the webhook\n7. Copy the generated webhook URL, which contains your secret code in the format `https://<domain>/rest/1/<secret-code>/<method>.json`",
        secrets: {
          BITRIX_WEBHOOK_URL: {
            label: "Webhook URL",
            required: true,
            placeholder: "https://your-domain.bitrix24.com/rest/1/xxx/",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  brevo: {
    label: "Brevo",
    environmentMapping: {
      BREVO_TOKEN: "$secrets.BREVO_TOKEN",
    },
    helpText:
      "Connect your Brevo account to manage email campaigns, transactional emails, and CRM contacts",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Brevo](https://app.brevo.com)\n2. Go to **Settings** → **SMTP & API** → **API Keys**\n3. Copy your API key",
        secrets: {
          BREVO_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "xkeysib-...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  "brave-search": {
    label: "Brave Search",
    environmentMapping: {
      BRAVE_API_KEY: "$secrets.BRAVE_API_KEY",
    },
    helpText:
      "Connect your Brave Search account to perform privacy-focused web, image, video, and news searches",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Go to the [Brave Search API dashboard](https://api-dashboard.search.brave.com/register) and sign up for an account\n2. Provide a credit card for identity verification (free plans will not be charged)\n3. After registration, your API key will be available in the dashboard\n4. Copy the API key and use it in the `X-Subscription-Token` request header",
        secrets: {
          BRAVE_API_KEY: {
            label: "API Key",
            required: true,
            placeholder: "BSAxxxxxxxxxxxxxxxx",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  "bright-data": {
    label: "Bright Data",
    environmentMapping: {
      BRIGHTDATA_TOKEN: "$secrets.BRIGHTDATA_TOKEN",
    },
    helpText:
      "Connect your Bright Data account to scrape websites, manage proxies, and access web data",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Bright Data](https://brightdata.com/cp)\n2. Go to **Account settings**\n3. Click **Add API key** and configure permissions\n4. Copy the token (shown only once)",
        secrets: {
          BRIGHTDATA_TOKEN: {
            label: "API Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  browserbase: {
    label: "Browserbase",
    environmentMapping: {
      BROWSERBASE_TOKEN: "$secrets.BROWSERBASE_TOKEN",
      BROWSERBASE_PROJECT_ID: "$vars.BROWSERBASE_PROJECT_ID",
    },
    helpText:
      "Connect your Browserbase account to create browser sessions, persist contexts, and automate cloud browsers",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Sign up for a [Browserbase](https://www.browserbase.com/sign-up) account\n2. Log in and navigate to the **Overview** dashboard\n3. Your **Project ID** and **API key** are displayed on the right side of the Overview page\n4. Copy the API key",
        secrets: {
          BROWSERBASE_TOKEN: {
            label: "API Token",
            required: true,
          },
          BROWSERBASE_PROJECT_ID: {
            label: "Project ID",
            required: true,
            type: "variable",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  browserless: {
    label: "Browserless",
    environmentMapping: {
      BROWSERLESS_TOKEN: "$secrets.BROWSERLESS_TOKEN",
    },
    helpText:
      "Connect your Browserless account to take screenshots, generate PDFs, scrape pages, and automate headless browsers",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Sign up or log in at [Browserless](https://browserless.io/account/)\n2. Navigate to the account dashboard\n3. Copy your API token from the dashboard",
        secrets: {
          BROWSERLESS_TOKEN: {
            label: "API Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  fireflies: {
    label: "Fireflies",
    environmentMapping: {
      FIREFLIES_TOKEN: "$secrets.FIREFLIES_TOKEN",
    },
    helpText:
      "Connect your Fireflies.ai account to transcribe and analyze meetings",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Fireflies](https://fireflies.ai)\n2. Navigate to the **Integrations** section\n3. Click on **Fireflies API**\n4. Copy your API key and store it securely",
        secrets: {
          FIREFLIES_TOKEN: {
            label: "API Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  firecrawl: {
    label: "Firecrawl",
    environmentMapping: {
      FIRECRAWL_TOKEN: "$secrets.FIRECRAWL_TOKEN",
    },
    helpText:
      "Connect your Firecrawl account to scrape webpages, crawl websites, and extract structured data",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Firecrawl](https://www.firecrawl.dev)\n2. Go to your **Dashboard**\n3. Copy your **API Key**",
        secrets: {
          FIRECRAWL_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "fc-xxxxxxxx",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  scrapeninja: {
    label: "ScrapeNinja",
    environmentMapping: {
      SCRAPENINJA_TOKEN: "$secrets.SCRAPENINJA_TOKEN",
    },
    helpText:
      "Connect your ScrapeNinja account to scrape web pages with Chrome TLS fingerprint and JS rendering",
    authMethods: {
      "api-token": {
        label: "API Token",
        secrets: {
          SCRAPENINJA_TOKEN: {
            label: "API Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  pdfco: {
    label: "PDF.co",
    environmentMapping: {
      PDFCO_TOKEN: "$secrets.PDFCO_TOKEN",
    },
    helpText:
      "Connect your PDF.co account to convert, merge, split, and extract data from PDF documents via API",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          PDFCO_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-pdfco-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  elevenlabs: {
    label: "ElevenLabs",
    environmentMapping: {
      ELEVENLABS_TOKEN: "$secrets.ELEVENLABS_TOKEN",
    },
    helpText:
      "Connect your ElevenLabs account to generate speech, clone voices, manage audio projects, and access sound effects",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [ElevenLabs](https://elevenlabs.io)\n2. Go to [Settings > API Keys](https://elevenlabs.io/app/settings/api-keys)\n3. Click to create a new API key\n4. Copy the key and store it securely",
        secrets: {
          ELEVENLABS_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-elevenlabs-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  explorium: {
    label: "Explorium",
    environmentMapping: {
      EXPLORIUM_TOKEN: "$secrets.EXPLORIUM_TOKEN",
    },
    helpText:
      "Connect your Explorium account to access business data enrichment, prospect discovery, and AI-powered data insights",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to the [Explorium Admin Portal](https://admin.explorium.ai)\n2. Navigate to **Access & Authentication > Getting Your API Key**\n3. Click the **Show Key** button to reveal the masked API key\n4. Click the **Copy Key** button to copy it",
        secrets: {
          EXPLORIUM_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-explorium-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  devto: {
    label: "Dev.to",
    environmentMapping: {
      DEVTO_TOKEN: "$secrets.DEVTO_TOKEN",
    },
    helpText:
      "Connect your Dev.to account to publish articles, manage posts, and interact with the developer community",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [DEV.to](https://dev.to)\n2. Go to **Settings > Extensions** (or visit [dev.to/settings/extensions](https://dev.to/settings/extensions))\n3. Generate a new API key from the settings page\n4. Copy the API key and use it in the `api-key` request header",
        secrets: {
          DEVTO_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-devto-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  fal: {
    label: "fal.ai",
    environmentMapping: {
      FAL_TOKEN: "$secrets.FAL_TOKEN",
    },
    helpText:
      "Connect your fal.ai account to run AI models for image generation, video generation, and other AI tasks",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Go to the [fal Dashboard Keys page](https://fal.ai/dashboard/keys)\n2. Click the **Create Key** button\n3. Provide a name for your key and select the appropriate scope (**API** for calling models, or **ADMIN** for full access)\n4. Copy the key immediately — you will not be able to see it again",
        secrets: {
          FAL_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "fal_...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  granola: {
    label: "Granola",
    environmentMapping: {
      GRANOLA_TOKEN: "$secrets.GRANOLA_TOKEN",
    },
    helpText:
      "Connect your Granola account to access meeting notes, transcripts, summaries, and calendar event details",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Open the [Granola](https://granola.ai) desktop app\n2. Go to **Settings > API**\n3. Click the **Create new key** button\n4. Choose a key type (if prompted) and click **Generate API Key**\n5. Copy and save the API key securely",
        secrets: {
          GRANOLA_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-granola-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  podchaser: {
    label: "Podchaser",
    environmentMapping: {
      PODCHASER_TOKEN: "$secrets.PODCHASER_TOKEN",
    },
    helpText:
      "Connect your Podchaser account to search podcasts, episodes, creators, and access podcast industry data",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Podchaser](https://www.podchaser.com)\n2. Go to [Profile > Settings > API](https://www.podchaser.com/profile/settings/api) to retrieve your **API Key** and **API Secret**\n3. Request an access token by sending a POST request to `https://api.podchaser.com/graphql` using the `requestAccessToken` mutation with `grant_type` set to `CLIENT_CREDENTIALS`, your API Key as `client_id`, and your API Secret as `client_secret`\n4. Store the returned access token (it lasts 1 year)",
        secrets: {
          PODCHASER_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "your-podchaser-access-token",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  pushinator: {
    label: "Pushinator",
    environmentMapping: {
      PUSHINATOR_TOKEN: "$secrets.PUSHINATOR_TOKEN",
    },
    helpText:
      "Connect your Pushinator account to send push notifications to mobile devices",
    authMethods: {
      "api-token": {
        label: "API Token",
        secrets: {
          PUSHINATOR_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "your-pushinator-api-token",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  qdrant: {
    label: "Qdrant",
    environmentMapping: {
      QDRANT_TOKEN: "$secrets.QDRANT_TOKEN",
      QDRANT_BASE_URL: "$vars.QDRANT_BASE_URL",
    },
    helpText:
      "Connect your Qdrant account to store, search, and manage vector embeddings",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Qdrant Cloud](https://cloud.qdrant.io)\n2. Open your cluster's detail page and go to **API Keys**\n3. Click **Create** and configure your key\n4. Copy the key (shown only once)",
        secrets: {
          QDRANT_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-qdrant-api-key",
          },
          QDRANT_BASE_URL: {
            label: "Cluster URL",
            required: true,
            placeholder: "https://your-cluster.region.cloud.qdrant.io:6333",
            type: "variable",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  qiita: {
    label: "Qiita",
    environmentMapping: {
      QIITA_TOKEN: "$secrets.QIITA_TOKEN",
    },
    helpText:
      "Connect your Qiita account to search, read, and publish technical articles",
    authMethods: {
      "api-token": {
        label: "Access Token",
        helpText:
          "1. Log in to [Qiita](https://qiita.com)\n2. Go to **Settings > Applications**\n3. Create a new access token with the desired scopes (e.g., `read_qiita`, `write_qiita`)\n4. Copy the generated token\n5. Use it in API requests with the header `Authorization: Bearer [your_token]`",
        secrets: {
          QIITA_TOKEN: {
            label: "Access Token",
            required: true,
            placeholder: "your-qiita-access-token",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  zeptomail: {
    label: "ZeptoMail",
    environmentMapping: {
      ZEPTOMAIL_TOKEN: "$secrets.ZEPTOMAIL_TOKEN",
    },
    helpText:
      "Connect your ZeptoMail account to send transactional emails via Zoho's email delivery service",
    authMethods: {
      "api-token": {
        label: "Send Mail Token",
        helpText:
          "1. Log in to [ZeptoMail](https://zeptomail.zoho.com)\n2. Select the Mail Agent for which you want to generate the API key\n3. Go to the **SMTP/API** tab\n4. In the **API** section, copy the **Agent alias** (agentkey)\n5. Submit a POST request to `https://api.zeptomail.com/v1.1/agents/{agentkey}/apikeys` with an `Authorization: Zoho-oauthtoken [your-token]` header\n6. The response will contain your send mail token (username and password)",
        secrets: {
          ZEPTOMAIL_TOKEN: {
            label: "Send Mail Token",
            required: true,
            placeholder: "your-zeptomail-send-mail-token",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  runway: {
    label: "Runway",
    environmentMapping: {
      RUNWAY_TOKEN: "$secrets.RUNWAY_TOKEN",
    },
    helpText:
      "Connect your Runway account to generate AI videos from images, text, or video inputs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign up for an account in the [Runway Developer Portal](https://dev.runwayml.com/)\n2. After signing up, create a new organization\n3. Click to the **API Keys** tab\n4. Create a new key, giving it a descriptive name\n5. Copy the key immediately and store it in a safe place — it will only be shown once",
        secrets: {
          RUNWAY_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-runway-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  shortio: {
    label: "Short.io",
    environmentMapping: {
      SHORTIO_TOKEN: "$secrets.SHORTIO_TOKEN",
    },
    helpText:
      "Connect your Short.io account to create and manage short links and track click analytics",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to the [Short.io](https://short.io) Dashboard\n2. Navigate to **Integrations and API**\n3. Click on **Create API key**\n4. Leave the **Public key** option disabled to create a private (secret) key\n5. Restrict the scope of the key to a specific team or domain\n6. Click **Create**\n7. Copy the key and store it in a safe place — secret keys cannot be recovered",
        secrets: {
          SHORTIO_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-shortio-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  streak: {
    label: "Streak",
    environmentMapping: {
      STREAK_TOKEN: "$secrets.STREAK_TOKEN",
    },
    helpText:
      "Connect your Streak account to manage CRM pipelines, contacts, and deals inside Gmail",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Install the Streak extension and navigate to [Gmail](https://mail.google.com)\n2. Click on the Streak icon in the right sidebar\n3. Select the **Integrations** button\n4. Under the **Streak API** section, click **Create New Key**\n5. Copy and store the API key securely",
        secrets: {
          STREAK_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-streak-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  strapi: {
    label: "Strapi",
    environmentMapping: {
      STRAPI_TOKEN: "$secrets.STRAPI_TOKEN",
      STRAPI_BASE_URL: "$vars.STRAPI_BASE_URL",
    },
    helpText:
      "Connect your Strapi CMS to manage content types, entries, and media via Strapi's REST API",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to your Strapi admin panel\n2. Go to **Settings → API Tokens**\n3. Click **Create new API Token**\n4. Enter a name, select a token duration, and choose a token type (Full Access or Custom)\n5. Click **Save** and copy the generated token",
        secrets: {
          STRAPI_TOKEN: {
            label: "API Token",
            required: true,
          },
          STRAPI_BASE_URL: {
            label: "Base URL",
            required: true,
            placeholder: "https://your-strapi.example.com",
            type: "variable",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  supadata: {
    label: "Supadata",
    environmentMapping: {
      SUPADATA_TOKEN: "$secrets.SUPADATA_TOKEN",
    },
    helpText:
      "Connect your Supadata account to extract YouTube transcripts, channel data, and video metadata",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Go to the [Supadata Dashboard](https://dash.supadata.ai)\n2. Sign up for an account (no credit card required)\n3. Your API key will be generated automatically\n4. Use it in API requests with the header `x-api-key: [your_api_key]`",
        secrets: {
          SUPADATA_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-supadata-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  tavily: {
    label: "Tavily",
    environmentMapping: {
      TAVILY_TOKEN: "$secrets.TAVILY_TOKEN",
    },
    helpText:
      "Connect your Tavily account to perform AI-optimized web searches and content extraction",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Go to [app.tavily.com](https://app.tavily.com/) and sign up for a free account\n2. After signing in, your API key will be available on the dashboard\n3. Copy the API key (it will start with `tvly-`)",
        secrets: {
          TAVILY_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "tvly-...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  tldv: {
    label: "tl;dv",
    environmentMapping: {
      TLDV_TOKEN: "$secrets.TLDV_TOKEN",
    },
    helpText:
      "Connect your tl;dv account to access meeting recordings, transcripts, and AI-generated notes",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Ensure you have a **Business Plan** subscription on [tldv](https://tldv.io)\n2. API and webhook access is only available on the Business Plan\n3. Contact support at **support@tldv.io** to request API access and obtain your credentials",
        secrets: {
          TLDV_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-tldv-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  twenty: {
    label: "Twenty",
    environmentMapping: {
      TWENTY_TOKEN: "$secrets.TWENTY_TOKEN",
    },
    helpText:
      "Connect your Twenty CRM account to manage contacts, companies, and deals",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to your [Twenty](https://twenty.com) workspace\n2. Go to **Settings > APIs & Webhooks**\n3. Click **+ Create key**\n4. Enter a descriptive **Name** and set an **Expiration Date**\n5. Click **Save**\n6. Copy the key immediately — it is only shown once",
        secrets: {
          TWENTY_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-twenty-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  youtube: {
    label: "YouTube",
    environmentMapping: {
      YOUTUBE_TOKEN: "$secrets.YOUTUBE_TOKEN",
    },
    helpText:
      "Connect your YouTube account to search videos, get channel info, and fetch comments via the Data API",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Go to [Google Cloud Console](https://console.cloud.google.com/)\n2. Enable **YouTube Data API v3**\n3. Go to **Credentials** → **Create Credentials** → **API Key**\n4. Copy the API key",
        secrets: {
          YOUTUBE_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "AIzaSy...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  zapier: {
    label: "Zapier",
    environmentMapping: {
      ZAPIER_TOKEN: "$secrets.ZAPIER_TOKEN",
    },
    helpText:
      "Connect your Zapier account to trigger zaps and use AI Actions (NLA) to automate workflows",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          ZAPIER_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-zapier-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  zapsign: {
    label: "ZapSign",
    environmentMapping: {
      ZAPSIGN_TOKEN: "$secrets.ZAPSIGN_TOKEN",
    },
    helpText:
      "Connect your ZapSign account to create documents for electronic signature and track signing status",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to your [ZapSign](https://app.zapsign.com) account\n2. Go to **Settings**\n3. Navigate to **Integrations**\n4. Select **ZAPSIGN API**\n5. Copy your API token",
        secrets: {
          ZAPSIGN_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "your-zapsign-api-token",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  zendesk: {
    label: "Zendesk",
    environmentMapping: {
      ZENDESK_API_TOKEN: "$secrets.ZENDESK_API_TOKEN",
      ZENDESK_EMAIL: "$vars.ZENDESK_EMAIL",
      ZENDESK_SUBDOMAIN: "$vars.ZENDESK_SUBDOMAIN",
    },
    helpText:
      "Connect your Zendesk account to manage support tickets, users, organizations, and automate customer support workflows",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Zendesk Admin Center](https://www.zendesk.com/admin/)\n2. Go to **Apps and integrations → APIs → Zendesk API**\n3. Enable **Token Access** under the Settings tab\n4. Click **Add API token** and copy the token",
        secrets: {
          ZENDESK_API_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "your-zendesk-api-token",
          },
          ZENDESK_EMAIL: {
            label: "Email",
            required: true,
            placeholder: "your-email@company.com",
            type: "variable",
          },
          ZENDESK_SUBDOMAIN: {
            label: "Subdomain",
            required: true,
            placeholder: "yourcompany",
            type: "variable",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  htmlcsstoimage: {
    label: "HTML/CSS to Image",
    environmentMapping: {
      HCTI_API_KEY: "$secrets.HCTI_API_KEY",
      HCTI_USER_ID: "$vars.HCTI_USER_ID",
    },
    helpText:
      "Connect your HTML/CSS to Image account to generate images from HTML and CSS",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [HTML/CSS to Image](https://htmlcsstoimage.com/dashboard)\n2. Go to your **Dashboard**\n3. Locate your **User ID** and **API Key** displayed on the dashboard\n4. Copy the **API Key** (used as the password in HTTP Basic authentication)",
        secrets: {
          HCTI_API_KEY: {
            label: "API Key",
            required: true,
          },
          HCTI_USER_ID: {
            label: "User ID",
            required: true,
            type: "variable",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  imgur: {
    label: "Imgur",
    environmentMapping: {
      IMGUR_CLIENT_ID: "$secrets.IMGUR_CLIENT_ID",
    },
    helpText: "Connect your Imgur account to upload, manage, and share images",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Imgur](https://imgur.com)\n2. Go to [Register an Application](https://api.imgur.com/oauth2/addclient)\n3. Fill in the application registration form\n4. After registration, you will receive a **Client ID** and **Client Secret**\n5. Copy and save both credentials",
        secrets: {
          IMGUR_CLIENT_ID: {
            label: "Client ID",
            required: true,
            placeholder: "your-imgur-client-id",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  instagram: {
    label: "Instagram",
    environmentMapping: {
      INSTAGRAM_TOKEN: "$secrets.INSTAGRAM_TOKEN",
      INSTAGRAM_BUSINESS_ACCOUNT_ID: "$vars.INSTAGRAM_BUSINESS_ACCOUNT_ID",
    },
    helpText:
      "Connect your Instagram Business account to manage posts, stories, and insights",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Create a Meta app of type **Business** at [Meta for Developers](https://developers.facebook.com/apps)\n2. In your app dashboard, click **Instagram > API setup with Instagram business login** in the left side menu\n3. Click **Generate token** next to the Instagram account you want to access\n4. Log into Instagram when prompted\n5. Copy the access token",
        secrets: {
          INSTAGRAM_TOKEN: {
            label: "Access Token",
            required: true,
          },
          INSTAGRAM_BUSINESS_ACCOUNT_ID: {
            label: "Business Account ID",
            required: true,
            type: "variable",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  "prisma-postgres": {
    label: "Prisma Postgres",
    environmentMapping: {
      PRISMA_POSTGRES_TOKEN: "$secrets.PRISMA_POSTGRES_TOKEN",
    },
    helpText:
      "Connect your Prisma Postgres database to manage schemas, run queries, and access data through Prisma's serverless database platform",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to the [Prisma Console](https://console.prisma.io)\n2. Go to your workspace **Settings** page\n3. Select **Service Tokens**\n4. Click **New Service Token**\n5. Copy and save the generated service token securely",
        secrets: {
          PRISMA_POSTGRES_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "eyJhbGci...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  discord: {
    label: "Discord",
    environmentMapping: {
      DISCORD_BOT_TOKEN: "$secrets.DISCORD_BOT_TOKEN",
    },
    helpText:
      "Connect your Discord bot to manage servers, channels, messages, and automate interactions",
    authMethods: {
      "api-token": {
        label: "Bot Token",
        helpText:
          "1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)\n2. Select your application (or create a new one)\n3. Navigate to the **Bot** page in your app's settings\n4. In the **Token** section, click **Reset Token** to generate a new bot token\n5. Copy and securely store the token — you won't be able to view it again unless you regenerate it",
        secrets: {
          DISCORD_BOT_TOKEN: {
            label: "Bot Token",
            required: true,
            placeholder: "your-discord-bot-token",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  lark: {
    label: "Lark",
    environmentMapping: {
      LARK_TOKEN: "$secrets.LARK_TOKEN",
      LARK_APP_ID: "$vars.LARK_APP_ID",
    },
    helpText:
      "Connect your Lark (Feishu) app to manage messages, documents, calendars, and workflows",
    authMethods: {
      "api-token": {
        label: "App Credentials",
        helpText:
          "1. Log in to the [Lark Developer Console](https://open.larksuite.com/app/)\n2. Select your app from the list (or create a new one)\n3. Go to the **Credentials & Basic Info** page\n4. Copy your **App ID** and **App Secret**\n5. Use these credentials to call the tenant_access_token API to obtain an access token",
        secrets: {
          LARK_TOKEN: {
            label: "App Secret",
            required: true,
            type: "secret",
          },
          LARK_APP_ID: {
            label: "App ID",
            required: true,
            type: "variable",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  mailsac: {
    label: "Mailsac",
    environmentMapping: {
      MAILSAC_TOKEN: "$secrets.MAILSAC_TOKEN",
    },
    helpText:
      "Connect your Mailsac account to manage disposable email inboxes for testing",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Go to [Mailsac](https://mailsac.com) and sign up for an account\n2. Log in to your Mailsac dashboard\n3. Navigate to [API Keys](https://mailsac.com/api-keys)\n4. Copy your API key from the dashboard",
        secrets: {
          MAILSAC_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-mailsac-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  manus: {
    label: "Manus",
    environmentMapping: {
      MANUS_TOKEN: "$secrets.MANUS_TOKEN",
    },
    helpText:
      "Connect your Manus account to run AI agent tasks, manage projects, upload files, and automate multi-step workflows",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to [Manus](https://manus.im)\n2. Navigate to **Settings → Integration → Build with Manus API**\n3. Click **Create New**, give it a name, and confirm\n4. Copy the generated API key",
        secrets: {
          MANUS_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-manus-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  minio: {
    label: "MinIO",
    environmentMapping: {
      MINIO_TOKEN: "$secrets.MINIO_TOKEN",
      MINIO_SECRET_TOKEN: "$secrets.MINIO_SECRET_TOKEN",
      MINIO_ENDPOINT: "$vars.MINIO_ENDPOINT",
    },
    helpText:
      "Connect your MinIO instance to manage S3-compatible object storage buckets and objects",
    authMethods: {
      "api-token": {
        label: "Access Credentials",
        helpText:
          "1. Log in to the MinIO Console\n2. Navigate to the **Access Keys** section under Security and Access\n3. Click **Create Access Key**\n4. The system automatically generates an access key and secret key\n5. Optionally override the auto-generated values or toggle **Restrict beyond user policy** to limit permissions\n6. Save the secret key in a secure location (you cannot retrieve or reset it after creation)\n7. Click **Create** to finalize",
        secrets: {
          MINIO_TOKEN: {
            label: "Access Key",
            required: true,
            type: "secret",
          },
          MINIO_SECRET_TOKEN: {
            label: "Secret Key",
            required: true,
            type: "secret",
          },
          MINIO_ENDPOINT: {
            label: "Endpoint URL",
            required: true,
            placeholder: "https://minio.example.com",
            type: "variable",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  pdforge: {
    label: "PDForge",
    environmentMapping: {
      PDFORGE_API_KEY: "$secrets.PDFORGE_API_KEY",
    },
    helpText:
      "Connect your PDForge account to generate PDF documents from templates",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Create an account on [pdforge](https://pdforge.com)\n2. Two API keys are automatically generated when you create your account\n3. Go to the **API Keys** menu in the sidebar to view your keys\n4. Copy your API key and use it in the `Authorization: Bearer pdfnoodle_api_[your_key]` header",
        secrets: {
          PDFORGE_API_KEY: {
            label: "API Key",
            required: true,
            placeholder: "your-pdforge-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  "discord-webhook": {
    label: "Discord Webhook",
    environmentMapping: {
      DISCORD_WEBHOOK_URL: "$secrets.DISCORD_WEBHOOK_URL",
    },
    helpText: "Connect a Discord webhook to send messages to channels",
    authMethods: {
      "api-token": {
        label: "Webhook URL",
        helpText:
          "1. Open your Discord server and navigate to **Server Settings**\n2. Select the **Integrations** tab\n3. Click the **Create Webhook** button\n4. Configure the webhook name and select the target text channel from the dropdown menu\n5. Click the **Copy Webhook URL** button to copy the webhook URL",
        secrets: {
          DISCORD_WEBHOOK_URL: {
            label: "Webhook URL",
            required: true,
            placeholder: "https://discord.com/api/webhooks/xxx/xxx",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  spotify: {
    label: "Spotify",
    environmentMapping: {
      SPOTIFY_TOKEN: "$secrets.SPOTIFY_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.SpotifyConnector,
    helpText:
      "Connect your Spotify account to manage playlists, control playback, and access music data",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Spotify to grant access.",
        secrets: {
          SPOTIFY_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          SPOTIFY_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://accounts.spotify.com/authorize",
      tokenUrl: "https://accounts.spotify.com/api/token",
      scopes: [
        "ugc-image-upload",
        "user-read-playback-state",
        "user-modify-playback-state",
        "user-read-currently-playing",
        "app-remote-control",
        "streaming",
        "playlist-read-private",
        "playlist-read-collaborative",
        "playlist-modify-private",
        "playlist-modify-public",
        "user-follow-modify",
        "user-follow-read",
        "user-read-playback-position",
        "user-top-read",
        "user-read-recently-played",
        "user-library-modify",
        "user-library-read",
        "user-read-email",
        "user-read-private",
      ],
    },
  },
  "slack-webhook": {
    label: "Slack Webhook",
    environmentMapping: {
      SLACK_WEBHOOK_URL: "$secrets.SLACK_WEBHOOK_URL",
    },
    helpText: "Connect a Slack incoming webhook to send messages to channels",
    authMethods: {
      "api-token": {
        label: "Webhook URL",
        helpText:
          "1. Create a [Slack app](https://api.slack.com/apps) (or use an existing one), choosing a workspace to associate it with\n2. From the app settings page, select **Incoming Webhooks**\n3. Toggle **Activate Incoming Webhooks** to on\n4. Click **Add New Webhook to Workspace**\n5. Pick a channel for the app to post to, then click **Authorize**\n6. Copy the webhook URL from the **Webhook URLs for Your Workspace** section (it will look like `https://hooks.slack.com/services/T.../B.../XXXX...`)",
        secrets: {
          SLACK_WEBHOOK_URL: {
            label: "Webhook URL",
            required: true,
            placeholder: "https://hooks.slack.com/services/xxx/xxx/xxx",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  gitlab: {
    label: "GitLab",
    environmentMapping: {
      GITLAB_TOKEN: "$secrets.GITLAB_TOKEN",
      GITLAB_HOST: "$vars.GITLAB_HOST",
    },
    helpText:
      "Connect your GitLab account to manage repositories, issues, merge requests, and CI/CD pipelines",
    authMethods: {
      "api-token": {
        label: "Personal Access Token",
        helpText:
          "1. Log in to [GitLab](https://gitlab.com)\n2. Click your avatar in the upper-right corner and select **Edit profile**\n3. In the left sidebar, navigate to **Access > Personal access tokens**\n4. From the **Generate token** dropdown, select **Legacy token**\n5. Enter a name in the **Token name** field\n6. Optionally set an expiration date (defaults to 365 days)\n7. Select the required scopes for your token\n8. Click **Generate token**\n9. Copy and save the token — you cannot view it again after leaving the page",
        secrets: {
          GITLAB_TOKEN: {
            label: "Personal Access Token",
            required: true,
          },
          GITLAB_HOST: {
            label: "GitLab Host",
            required: false,
            placeholder: "gitlab.com",
            type: "variable",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  wix: {
    label: "Wix",
    environmentMapping: {
      WIX_TOKEN: "$secrets.WIX_TOKEN",
    },
    helpText:
      "Connect your Wix account to manage sites, collections, and content",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to your [Wix](https://www.wix.com) account (account owner or co-owner access required)\n2. Go to the [API Keys Manager](https://manage.wix.com/account/api-keys)\n3. Create a new API key and assign the required permissions\n4. Copy the generated API key and store it securely",
        secrets: {
          WIX_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-wix-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
  v0: {
    label: "v0",
    environmentMapping: {
      V0_TOKEN: "$secrets.V0_TOKEN",
    },
    helpText:
      "Connect your v0 account to generate UI components, chat completions, and iterate on React and Next.js code with the v0 Platform API",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [v0](https://v0.dev)\n2. Go to **Settings** → **Keys** ([direct link](https://v0.dev/chat/settings/keys))\n3. Create a new API key\n4. Copy the generated token",
        secrets: {
          V0_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "v0-...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} satisfies Record<string, ConnectorConfig>;

export type ConnectorType = keyof typeof CONNECTOR_TYPES_DEF;

export const CONNECTOR_TYPES: Record<ConnectorType, ConnectorConfig> =
  CONNECTOR_TYPES_DEF;
export const connectorTypeSchema = z.enum(
  Object.keys(CONNECTOR_TYPES_DEF) as [ConnectorType, ...ConnectorType[]],
);
