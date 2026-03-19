import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { FeatureSwitchKey } from "../feature-switch-key";

const c = initContract();

/**
 * Secret field configuration for connector auth methods
 */
export interface ConnectorSecretConfig {
  label: string;
  required: boolean;
  placeholder?: string;
  helpText?: string;
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
 *
 * `environmentMapping` lives here because it only applies to the OAuth path:
 * OAuth stores secrets under internal names (e.g. `FIGMA_ACCESS_TOKEN`) that
 * need to be mapped to the env var names skills expect (e.g. `FIGMA_TOKEN`).
 * API-token connectors store secrets directly under the target name, so they
 * don't need any mapping.
 *
 * `$secrets.X` in mapping values looks up secret X from the connector's secrets.
 */
export interface ConnectorOAuthConfig {
  authorizationUrl?: string;
  tokenUrl: string;
  scopes: string[];
  environmentMapping: Record<string, string>;
}

/**
 * Base configuration shape for all connector types.
 */
export interface ConnectorConfig {
  readonly label: string;
  readonly helpText: string;
  readonly featureFlag?: FeatureSwitchKey;
  readonly authMethods: Record<string, ConnectorAuthMethodConfig>;
  readonly defaultAuthMethod?: string;
  /** Non-OAuth environment mapping (e.g. computer connector bridge credentials). */
  readonly bridgeMapping?: Record<string, string>;
  readonly oauth?: ConnectorOAuthConfig;
}

/**
 * Connector type configuration
 * Maps type to display info, auth methods, and OAuth environment mapping.
 */
const CONNECTOR_TYPES_DEF = {
  axiom: {
    label: "Axiom",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  ahrefs: {
    label: "Ahrefs",
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
        secrets: {
          AHREFS_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "your-ahrefs-api-token",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
    oauth: {
      authorizationUrl: "https://app.ahrefs.com/api/auth",
      tokenUrl: "https://app.ahrefs.com/api/token",
      scopes: ["api"],
      environmentMapping: {
        AHREFS_TOKEN: "$secrets.AHREFS_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  agentmail: {
    label: "AgentMail",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  airtable: {
    label: "Airtable",
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
    } as Record<string, ConnectorAuthMethodConfig>,
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
      environmentMapping: {
        AIRTABLE_TOKEN: "$secrets.AIRTABLE_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  github: {
    label: "GitHub",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["repo", "project"],
      environmentMapping: {
        GH_TOKEN: "$secrets.GITHUB_ACCESS_TOKEN",
        GITHUB_TOKEN: "$secrets.GITHUB_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  notion: {
    label: "Notion",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
      tokenUrl: "https://api.notion.com/v1/oauth/token",
      scopes: [],
      environmentMapping: {
        NOTION_TOKEN: "$secrets.NOTION_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  gmail: {
    label: "Gmail",
    featureFlag: FeatureSwitchKey.GmailConnector,
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      environmentMapping: {
        GMAIL_TOKEN: "$secrets.GMAIL_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  "google-sheets": {
    label: "Google Sheets",
    featureFlag: FeatureSwitchKey.GoogleSheetsConnector,
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
      environmentMapping: {
        GOOGLE_SHEETS_TOKEN: "$secrets.GOOGLE_SHEETS_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  "google-docs": {
    label: "Google Docs",
    featureFlag: FeatureSwitchKey.GoogleDocsConnector,
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: [
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
      environmentMapping: {
        GOOGLE_DOCS_TOKEN: "$secrets.GOOGLE_DOCS_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  "google-drive": {
    label: "Google Drive",
    featureFlag: FeatureSwitchKey.GoogleDriveConnector,
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
      environmentMapping: {
        GOOGLE_DRIVE_TOKEN: "$secrets.GOOGLE_DRIVE_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  "google-calendar": {
    label: "Google Calendar",
    featureFlag: FeatureSwitchKey.GoogleCalendarConnector,
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: [
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
      environmentMapping: {
        GOOGLE_CALENDAR_TOKEN: "$secrets.GOOGLE_CALENDAR_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  close: {
    label: "Close",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://app.close.com/oauth2/authorize/",
      tokenUrl: "https://api.close.com/oauth2/token/",
      scopes: ["all.full_access", "offline_access"],
      environmentMapping: {
        CLOSE_TOKEN: "$secrets.CLOSE_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  "hugging-face": {
    label: "Hugging Face",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  hume: {
    label: "Hume",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  heygen: {
    label: "HeyGen",
    helpText:
      "Connect your HeyGen account to create AI-generated videos, manage avatars, and automate video production",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          HEYGEN_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-heygen-api-key",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  hubspot: {
    label: "HubSpot",
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
    } as Record<string, ConnectorAuthMethodConfig>,
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
      environmentMapping: {
        HUBSPOT_TOKEN: "$secrets.HUBSPOT_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  computer: {
    label: "Computer",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api",
    bridgeMapping: {
      COMPUTER_CONNECTOR_BRIDGE_TOKEN:
        "$secrets.COMPUTER_CONNECTOR_BRIDGE_TOKEN",
      COMPUTER_CONNECTOR_DOMAIN: "$secrets.COMPUTER_CONNECTOR_DOMAIN",
    },
  },
  slack: {
    label: "Slack",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://slack.com/oauth/v2/authorize",
      tokenUrl: "https://slack.com/api/oauth.v2.access",
      scopes: [
        "channels:read",
        "channels:history",
        "chat:write",
        "users:read",
        "users:read.email",
        "files:read",
      ],
      environmentMapping: {
        SLACK_TOKEN: "$secrets.SLACK_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  docusign: {
    label: "DocuSign",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://account.docusign.com/oauth/auth",
      tokenUrl: "https://account.docusign.com/oauth/token",
      scopes: ["signature", "extended", "openid"],
      environmentMapping: {
        DOCUSIGN_TOKEN: "$secrets.DOCUSIGN_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  dropbox: {
    label: "Dropbox",
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
        secrets: {
          DROPBOX_TOKEN: {
            label: "Access Token",
            required: true,
            placeholder: "sl.xxxxxxxx",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://www.dropbox.com/oauth2/authorize",
      tokenUrl: "https://api.dropboxapi.com/oauth2/token",
      scopes: [
        "account_info.read",
        "files.metadata.read",
        "files.content.read",
      ],
      environmentMapping: {
        DROPBOX_TOKEN: "$secrets.DROPBOX_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  linear: {
    label: "Linear",
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
    } as Record<string, ConnectorAuthMethodConfig>,
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
      environmentMapping: {
        LINEAR_TOKEN: "$secrets.LINEAR_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  intercom: {
    label: "Intercom",
    helpText:
      "Connect your Intercom account to manage customer conversations, contacts, messages, and support tickets",
    authMethods: {
      "api-token": {
        label: "Access Token",
        secrets: {
          INTERCOM_TOKEN: {
            label: "Access Token",
            required: true,
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  jam: {
    label: "Jam",
    helpText:
      "Connect your Jam account to capture bugs, manage reports, and access debugging telemetry",
    authMethods: {
      "api-token": {
        label: "Personal Access Token",
        secrets: {
          JAM_TOKEN: {
            label: "Personal Access Token",
            required: true,
            placeholder: "jam_pat_...",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  jotform: {
    label: "Jotform",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  line: {
    label: "LINE",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  make: {
    label: "Make",
    helpText:
      "Connect your Make account to manage scenarios, organizations, and automation workflows",
    authMethods: {
      "api-token": {
        label: "API Token",
        secrets: {
          MAKE_TOKEN: {
            label: "API Token",
            required: true,
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  metabase: {
    label: "Metabase",
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
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  deel: {
    label: "Deel",
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
        secrets: {
          DEEL_TOKEN: {
            label: "API Token",
            required: true,
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
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
      environmentMapping: {
        DEEL_TOKEN: "$secrets.DEEL_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  deepseek: {
    label: "DeepSeek",
    helpText:
      "Connect your DeepSeek account to use DeepSeek AI models for chat completions, code generation, and reasoning tasks",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          DEEPSEEK_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "sk-...",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  clickup: {
    label: "ClickUp",
    helpText:
      "Connect your ClickUp account to manage tasks, projects, and team workflows",
    authMethods: {
      "api-token": {
        label: "API Token",
        secrets: {
          CLICKUP_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "pk_...",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  cloudflare: {
    label: "Cloudflare",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  cronlytic: {
    label: "Cronlytic",
    helpText:
      "Connect your Cronlytic account to monitor cron jobs and scheduled tasks",
    authMethods: {
      "api-token": {
        label: "API Key",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  dify: {
    label: "Dify",
    helpText:
      "Connect your Dify account to build and manage AI-powered workflows, chatbots, and agentic applications",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          DIFY_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "app-...",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  figma: {
    label: "Figma",
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
        secrets: {
          FIGMA_TOKEN: {
            label: "Personal Access Token",
            required: true,
            placeholder: "figd_xxxxxxxx",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
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
      environmentMapping: {
        FIGMA_TOKEN: "$secrets.FIGMA_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  mercury: {
    label: "Mercury",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://oauth2.mercury.com/oauth2/auth",
      tokenUrl: "https://oauth2.mercury.com/oauth2/token",
      scopes: ["offline_access"],
      environmentMapping: {
        MERCURY_TOKEN: "$secrets.MERCURY_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  minimax: {
    label: "MiniMax",
    helpText:
      "Connect your MiniMax account to access AI model APIs for text, voice, and video generation",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          MINIMAX_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-minimax-api-key",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  reportei: {
    label: "Reportei",
    helpText:
      "Connect your Reportei account to generate and manage marketing reports with automated analytics",
    authMethods: {
      "api-token": {
        label: "API Token",
        secrets: {
          REPORTEI_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "your-reportei-api-token",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  serpapi: {
    label: "SerpApi",
    helpText:
      "Connect your SerpApi account to search Google, Bing, YouTube and other search engines programmatically",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          SERPAPI_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-serpapi-api-key",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  reddit: {
    label: "Reddit",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://www.reddit.com/api/v1/authorize",
      tokenUrl: "https://www.reddit.com/api/v1/access_token",
      scopes: ["identity", "read"],
      environmentMapping: {
        REDDIT_TOKEN: "$secrets.REDDIT_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  strava: {
    label: "Strava",
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
    } as Record<string, ConnectorAuthMethodConfig>,
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
      environmentMapping: {
        STRAVA_TOKEN: "$secrets.STRAVA_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  x: {
    label: "X",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://twitter.com/i/oauth2/authorize",
      tokenUrl: "https://api.twitter.com/2/oauth2/token",
      scopes: ["tweet.read", "users.read", "follows.read", "offline.access"],
      environmentMapping: {
        X_ACCESS_TOKEN: "$secrets.X_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  neon: {
    label: "Neon",
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
        secrets: {
          NEON_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "napi_xxxxxxxx",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
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
      environmentMapping: {
        NEON_TOKEN: "$secrets.NEON_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  "garmin-connect": {
    label: "Garmin Connect",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://connect.garmin.com/oauth2Confirm",
      tokenUrl: "https://diauth.garmin.com/di-oauth2-service/oauth/token",
      scopes: [],
      environmentMapping: {
        GARMIN_CONNECT_TOKEN: "$secrets.GARMIN_CONNECT_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  vercel: {
    label: "Vercel",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    oauth: {
      tokenUrl: "https://api.vercel.com/v2/oauth/access_token",
      scopes: [],
      environmentMapping: {
        VERCEL_TOKEN: "$secrets.VERCEL_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  sentry: {
    label: "Sentry",
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
    } as Record<string, ConnectorAuthMethodConfig>,
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
      environmentMapping: {
        SENTRY_TOKEN: "$secrets.SENTRY_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  posthog: {
    label: "PostHog",
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
        secrets: {
          POSTHOG_TOKEN: {
            label: "Personal API Key",
            required: true,
            placeholder: "phx_...",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
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
      environmentMapping: {
        POSTHOG_TOKEN: "$secrets.POSTHOG_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  productlane: {
    label: "Productlane",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  "intervals-icu": {
    label: "Intervals.icu",
    featureFlag: FeatureSwitchKey.IntervalsIcuConnector,
    helpText:
      "Connect your Intervals.icu account to access training, activity, wellness, and calendar data",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Intervals.icu to grant access.",
        secrets: {
          INTERVALS_ICU_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
        },
      },
      "api-token": {
        label: "API Key",
        secrets: {
          INTERVALS_ICU_TOKEN: {
            label: "API Key",
            required: true,
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://intervals.icu/oauth/authorize",
      tokenUrl: "https://intervals.icu/api/oauth/token",
      scopes: ["ACTIVITY", "WELLNESS", "CALENDAR", "SETTINGS", "LIBRARY"],
      environmentMapping: {
        INTERVALS_ICU_TOKEN: "$secrets.INTERVALS_ICU_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  monday: {
    label: "Monday.com",
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
    } as Record<string, ConnectorAuthMethodConfig>,
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
      environmentMapping: {
        MONDAY_TOKEN: "$secrets.MONDAY_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  canva: {
    label: "Canva",
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
    } as Record<string, ConnectorAuthMethodConfig>,
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
      environmentMapping: {
        CANVA_TOKEN: "$secrets.CANVA_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  xero: {
    label: "Xero",
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
    } as Record<string, ConnectorAuthMethodConfig>,
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
      environmentMapping: {
        XERO_TOKEN: "$secrets.XERO_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  supabase: {
    label: "Supabase",
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
        secrets: {
          SUPABASE_TOKEN: {
            label: "Service Role Key",
            required: true,
            placeholder: "eyJhbGci... or sb_secret_...",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
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
      environmentMapping: {
        SUPABASE_TOKEN: "$secrets.SUPABASE_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  todoist: {
    label: "Todoist",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://todoist.com/oauth/authorize",
      tokenUrl: "https://todoist.com/oauth/access_token",
      scopes: ["data:read_write", "data:delete", "project:delete"],
      environmentMapping: {
        TODOIST_TOKEN: "$secrets.TODOIST_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  webflow: {
    label: "Webflow",
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
        secrets: {
          WEBFLOW_TOKEN: {
            label: "Site Token",
            required: true,
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
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
      environmentMapping: {
        WEBFLOW_TOKEN: "$secrets.WEBFLOW_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  wrike: {
    label: "Wrike",
    helpText:
      "Connect your Wrike account to manage projects, tasks, folders, and workflows",
    authMethods: {
      "api-token": {
        label: "Permanent Access Token",
        secrets: {
          WRIKE_TOKEN: {
            label: "Permanent Access Token",
            required: true,
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  "outlook-mail": {
    label: "Outlook Mail",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl:
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      scopes: ["Mail.ReadWrite", "Mail.Send", "User.Read", "offline_access"],
      environmentMapping: {
        OUTLOOK_MAIL_TOKEN: "$secrets.OUTLOOK_MAIL_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  "outlook-calendar": {
    label: "Outlook Calendar",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl:
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      scopes: ["Calendars.ReadWrite", "User.Read", "offline_access"],
      environmentMapping: {
        OUTLOOK_CALENDAR_TOKEN: "$secrets.OUTLOOK_CALENDAR_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  asana: {
    label: "Asana",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://app.asana.com/-/oauth_authorize",
      tokenUrl: "https://app.asana.com/-/oauth_token",
      scopes: [],
      environmentMapping: {
        ASANA_TOKEN: "$secrets.ASANA_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  atlassian: {
    label: "Atlassian (Jira/Confluence)",
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
            helpText:
              "The email address associated with your Atlassian account",
            type: "variable",
          },
          ATLASSIAN_DOMAIN: {
            label: "Domain",
            required: true,
            placeholder: "mycompany",
            helpText:
              "Your Atlassian domain (e.g. 'mycompany' from mycompany.atlassian.net)",
            type: "variable",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  "meta-ads": {
    label: "Meta Ads",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://www.facebook.com/v22.0/dialog/oauth",
      tokenUrl: "https://graph.facebook.com/v22.0/oauth/access_token",
      scopes: ["ads_management", "ads_read", "business_management"],
      environmentMapping: {
        META_ADS_TOKEN: "$secrets.META_ADS_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  stripe: {
    label: "Stripe",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://connect.stripe.com/oauth/authorize",
      tokenUrl: "https://connect.stripe.com/oauth/token",
      scopes: ["read_write"],
      environmentMapping: {
        STRIPE_TOKEN: "$secrets.STRIPE_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  openai: {
    label: "OpenAI",
    helpText:
      "Connect your OpenAI account to access GPT models, embeddings, image generation, and other AI capabilities",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          OPENAI_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "sk-...",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  similarweb: {
    label: "SimilarWeb",
    helpText:
      "Connect your SimilarWeb account to access website traffic analytics, competitive intelligence, and market insights",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          SIMILARWEB_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-similarweb-api-key",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  perplexity: {
    label: "Perplexity",
    helpText:
      "Connect your Perplexity account to access AI-powered search and research capabilities via the Sonar API",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          PERPLEXITY_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "pplx-...",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  plausible: {
    label: "Plausible",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  mailchimp: {
    label: "Mailchimp",
    featureFlag: FeatureSwitchKey.MailchimpConnector,
    helpText:
      "Connect your Mailchimp account to manage audiences, campaigns, templates, and automations",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          MAILCHIMP_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-us00",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
    oauth: {
      authorizationUrl: "https://login.mailchimp.com/oauth2/authorize",
      tokenUrl: "https://login.mailchimp.com/oauth2/token",
      scopes: [],
      environmentMapping: {
        MAILCHIMP_TOKEN: "$secrets.MAILCHIMP_ACCESS_TOKEN",
      },
    } as ConnectorOAuthConfig,
  },
  chatwoot: {
    label: "Chatwoot",
    helpText:
      "Connect your Chatwoot account to manage conversations, contacts, and customer support workflows",
    authMethods: {
      "api-token": {
        label: "API Access Token",
        secrets: {
          CHATWOOT_TOKEN: {
            label: "API Access Token",
            required: true,
            placeholder: "your-chatwoot-access-token",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  resend: {
    label: "Resend",
    featureFlag: FeatureSwitchKey.ResendConnector,
    helpText:
      "Connect your Resend account to send transactional emails, manage domains, audiences, and contacts",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          RESEND_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "re_xxxxxxxxxx",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  revenuecat: {
    label: "RevenueCat",
    helpText:
      "Connect your RevenueCat account to manage in-app subscriptions, purchases, and customer data",
    authMethods: {
      "api-token": {
        label: "Secret API Key",
        secrets: {
          REVENUECAT_TOKEN: {
            label: "Secret API Key",
            required: true,
            placeholder: "sk_xxxxxxxxxxxxxxxx",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  pdf4me: {
    label: "PDF4me",
    helpText:
      "Connect your PDF4me account to convert, merge, split, compress, and manipulate PDF documents",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          PDF4ME_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-pdf4me-api-key",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  apify: {
    label: "Apify",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  bitrix: {
    label: "Bitrix24",
    helpText:
      "Connect your Bitrix24 account to manage CRM, tasks, and workflows",
    authMethods: {
      "api-token": {
        label: "Webhook URL",
        secrets: {
          BITRIX_WEBHOOK_URL: {
            label: "Webhook URL",
            required: true,
            placeholder: "https://your-domain.bitrix24.com/rest/1/xxx/",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  "brave-search": {
    label: "Brave Search",
    helpText:
      "Connect your Brave Search account to perform privacy-focused web, image, video, and news searches",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          BRAVE_API_KEY: {
            label: "API Key",
            required: true,
            placeholder: "BSAxxxxxxxxxxxxxxxx",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  "bright-data": {
    label: "Bright Data",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  browserbase: {
    label: "Browserbase",
    helpText:
      "Connect your Browserbase account to create browser sessions, persist contexts, and automate cloud browsers",
    authMethods: {
      "api-token": {
        label: "API Token",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  browserless: {
    label: "Browserless",
    helpText:
      "Connect your Browserless account to take screenshots, generate PDFs, scrape pages, and automate headless browsers",
    authMethods: {
      "api-token": {
        label: "API Token",
        secrets: {
          BROWSERLESS_TOKEN: {
            label: "API Token",
            required: true,
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  fireflies: {
    label: "Fireflies",
    helpText:
      "Connect your Fireflies.ai account to transcribe and analyze meetings",
    authMethods: {
      "api-token": {
        label: "API Token",
        secrets: {
          FIREFLIES_TOKEN: {
            label: "API Token",
            required: true,
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  firecrawl: {
    label: "Firecrawl",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  scrapeninja: {
    label: "ScrapeNinja",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  pdfco: {
    label: "PDF.co",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  elevenlabs: {
    label: "ElevenLabs",
    helpText:
      "Connect your ElevenLabs account to generate speech, clone voices, manage audio projects, and access sound effects",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          ELEVENLABS_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-elevenlabs-api-key",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  explorium: {
    label: "Explorium",
    helpText:
      "Connect your Explorium account to access business data enrichment, prospect discovery, and AI-powered data insights",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          EXPLORIUM_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-explorium-api-key",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  devto: {
    label: "Dev.to",
    helpText:
      "Connect your Dev.to account to publish articles, manage posts, and interact with the developer community",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          DEVTO_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-devto-api-key",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  fal: {
    label: "fal.ai",
    helpText:
      "Connect your fal.ai account to run AI models for image generation, video generation, and other AI tasks",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          FAL_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "fal_...",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  granola: {
    label: "Granola",
    helpText:
      "Connect your Granola account to access meeting notes, transcripts, summaries, and calendar event details",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          GRANOLA_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-granola-api-key",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  podchaser: {
    label: "Podchaser",
    helpText:
      "Connect your Podchaser account to search podcasts, episodes, creators, and access podcast industry data",
    authMethods: {
      "api-token": {
        label: "API Token",
        secrets: {
          PODCHASER_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "your-podchaser-access-token",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  pushinator: {
    label: "Pushinator",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  qdrant: {
    label: "Qdrant",
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
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  qiita: {
    label: "Qiita",
    helpText:
      "Connect your Qiita account to search, read, and publish technical articles",
    authMethods: {
      "api-token": {
        label: "Access Token",
        secrets: {
          QIITA_TOKEN: {
            label: "Access Token",
            required: true,
            placeholder: "your-qiita-access-token",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  zeptomail: {
    label: "ZeptoMail",
    helpText:
      "Connect your ZeptoMail account to send transactional emails via Zoho's email delivery service",
    authMethods: {
      "api-token": {
        label: "Send Mail Token",
        secrets: {
          ZEPTOMAIL_TOKEN: {
            label: "Send Mail Token",
            required: true,
            placeholder: "your-zeptomail-send-mail-token",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  runway: {
    label: "Runway",
    helpText:
      "Connect your Runway account to generate AI videos from images, text, or video inputs",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          RUNWAY_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-runway-api-key",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  shortio: {
    label: "Short.io",
    helpText:
      "Connect your Short.io account to create and manage short links and track click analytics",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          SHORTIO_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-shortio-api-key",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  streak: {
    label: "Streak",
    helpText:
      "Connect your Streak account to manage CRM pipelines, contacts, and deals inside Gmail",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          STREAK_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-streak-api-key",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  supadata: {
    label: "Supadata",
    helpText:
      "Connect your Supadata account to extract YouTube transcripts, channel data, and video metadata",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          SUPADATA_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-supadata-api-key",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  tavily: {
    label: "Tavily",
    helpText:
      "Connect your Tavily account to perform AI-optimized web searches and content extraction",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          TAVILY_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "tvly-...",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  tldv: {
    label: "tl;dv",
    helpText:
      "Connect your tl;dv account to access meeting recordings, transcripts, and AI-generated notes",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          TLDV_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-tldv-api-key",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  twenty: {
    label: "Twenty",
    helpText:
      "Connect your Twenty CRM account to manage contacts, companies, and deals",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          TWENTY_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-twenty-api-key",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  youtube: {
    label: "YouTube",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  zapier: {
    label: "Zapier",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  zapsign: {
    label: "ZapSign",
    helpText:
      "Connect your ZapSign account to create documents for electronic signature and track signing status",
    authMethods: {
      "api-token": {
        label: "API Token",
        secrets: {
          ZAPSIGN_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "your-zapsign-api-token",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  zendesk: {
    label: "Zendesk",
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
            helpText: "The email address associated with your Zendesk account",
            type: "variable",
          },
          ZENDESK_SUBDOMAIN: {
            label: "Subdomain",
            required: true,
            placeholder: "yourcompany",
            helpText:
              "Your Zendesk subdomain (e.g. 'yourcompany' from yourcompany.zendesk.com)",
            type: "variable",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  htmlcsstoimage: {
    label: "HTML/CSS to Image",
    helpText:
      "Connect your HTML/CSS to Image account to generate images from HTML and CSS",
    authMethods: {
      "api-token": {
        label: "API Key",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  imgur: {
    label: "Imgur",
    helpText: "Connect your Imgur account to upload, manage, and share images",
    authMethods: {
      "api-token": {
        label: "API Token",
        secrets: {
          IMGUR_CLIENT_ID: {
            label: "Client ID",
            required: true,
            placeholder: "your-imgur-client-id",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  instagram: {
    label: "Instagram",
    helpText:
      "Connect your Instagram Business account to manage posts, stories, and insights",
    authMethods: {
      "api-token": {
        label: "API Token",
        secrets: {
          INSTAGRAM_ACCESS_TOKEN: {
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  "prisma-postgres": {
    label: "Prisma Postgres",
    helpText:
      "Connect your Prisma Postgres database to manage schemas, run queries, and access data through Prisma's serverless database platform",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          PRISMA_POSTGRES_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "eyJhbGci...",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  pdforge: {
    label: "PDForge",
    helpText:
      "Connect your PDForge account to generate PDF documents from templates",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          PDFORGE_API_KEY: {
            label: "API Key",
            required: true,
            placeholder: "your-pdforge-api-key",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  "slack-webhook": {
    label: "Slack Webhook",
    helpText: "Connect a Slack incoming webhook to send messages to channels",
    authMethods: {
      "api-token": {
        label: "Webhook URL",
        secrets: {
          SLACK_WEBHOOK_URL: {
            label: "Webhook URL",
            required: true,
            placeholder: "https://hooks.slack.com/services/xxx/xxx/xxx",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
  wix: {
    label: "Wix",
    helpText:
      "Connect your Wix account to manage sites, collections, and content",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          WIX_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-wix-api-key",
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "api-token",
  },
} satisfies Record<string, ConnectorConfig>;

export type ConnectorType = keyof typeof CONNECTOR_TYPES_DEF;

export const CONNECTOR_TYPES: Record<ConnectorType, ConnectorConfig> =
  CONNECTOR_TYPES_DEF;
export const connectorTypeSchema = z.enum([
  "agentmail",
  "ahrefs",
  "atlassian",
  "axiom",
  "airtable",
  "asana",
  "canva",
  "clickup",
  "cloudflare",
  "close",
  "github",
  "gmail",
  "google-sheets",
  "hugging-face",
  "hume",
  "heygen",
  "hubspot",
  "google-docs",
  "google-drive",
  "google-calendar",
  "notion",
  "computer",
  "slack",
  "deel",
  "deepseek",
  "dify",
  "docusign",
  "dropbox",
  "linear",
  "intercom",
  "jam",
  "jotform",
  "line",
  "make",
  "metabase",
  "figma",
  "mercury",
  "minimax",
  "reddit",
  "strava",
  "neon",
  "garmin-connect",
  "x",
  "vercel",
  "sentry",
  "intervals-icu",
  "xero",
  "monday",
  "supabase",
  "todoist",
  "webflow",
  "outlook-mail",
  "outlook-calendar",
  "meta-ads",
  "posthog",
  "stripe",
  "openai",
  "chatwoot",
  "similarweb",
  "mailchimp",
  "pdfco",
  "perplexity",
  "plausible",
  "productlane",
  "resend",
  "revenuecat",
  "pdf4me",
  "apify",
  "bright-data",
  "browserbase",
  "browserless",
  "fireflies",
  "firecrawl",
  "scrapeninja",
  "elevenlabs",
  "explorium",
  "devto",
  "fal",
  "granola",
  "podchaser",
  "pushinator",
  "qdrant",
  "qiita",
  "reportei",
  "serpapi",
  "zeptomail",
  "runway",
  "shortio",
  "streak",
  "supadata",
  "tavily",
  "tldv",
  "twenty",
  "youtube",
  "wrike",
  "zapier",
  "zapsign",
  "zendesk",
  "prisma-postgres",
  "bitrix",
  "brave-search",
  "cronlytic",
  "htmlcsstoimage",
  "imgur",
  "instagram",
  "pdforge",
  "slack-webhook",
  "wix",
]);

/**
 * Get auth methods for a connector type
 */
export function getConnectorAuthMethods(
  type: ConnectorType,
): Record<string, ConnectorAuthMethodConfig> {
  return CONNECTOR_TYPES[type].authMethods;
}

/**
 * Get default auth method for a connector type
 */
export function getConnectorDefaultAuthMethod(
  type: ConnectorType,
): string | undefined {
  return CONNECTOR_TYPES[type].defaultAuthMethod;
}

/**
 * Get secrets config for a specific auth method
 */
export function getConnectorSecretsForAuthMethod(
  type: ConnectorType,
  authMethod: string,
): Record<string, ConnectorSecretConfig> | undefined {
  const authMethods = getConnectorAuthMethods(type);
  return authMethods[authMethod]?.secrets;
}

/**
 * Get secret names for a specific auth method
 */
export function getConnectorSecretNames(
  type: ConnectorType,
  authMethod: string,
): string[] {
  const secrets = getConnectorSecretsForAuthMethod(type, authMethod);
  return secrets ? Object.keys(secrets) : [];
}

/**
 * Get environment mapping for a connector type.
 *
 * For OAuth connectors, reads from `oauth.environmentMapping`.
 * For special connectors (e.g. computer), reads from `bridgeMapping`.
 */
export function getConnectorEnvironmentMapping(
  type: ConnectorType,
): Record<string, string> {
  const config = CONNECTOR_TYPES[type];
  return config.oauth?.environmentMapping ?? config.bridgeMapping ?? {};
}

/**
 * Get connector label and derived env var names for a connector secret.
 * Performs a reverse lookup from secret name to the connector type and
 * environment mapping that references it.
 *
 * Example: getConnectorDerivedNames("GITHUB_ACCESS_TOKEN")
 * → { connectorLabel: "GitHub", envVarNames: ["GH_TOKEN", "GITHUB_TOKEN"] }
 */
export function getConnectorDerivedNames(
  secretName: string,
): { connectorLabel: string; envVarNames: string[] } | null {
  const allTypes = Object.keys(CONNECTOR_TYPES) as ConnectorType[];

  for (const type of allTypes) {
    const config = CONNECTOR_TYPES[type];

    // Check if this secret belongs to any auth method of this connector
    const authMethods = config.authMethods as Record<
      string,
      ConnectorAuthMethodConfig
    >;
    let found = false;
    for (const method of Object.values(authMethods)) {
      if (method.secrets && secretName in method.secrets) {
        found = true;
        break;
      }
    }

    if (!found) {
      continue;
    }

    // Find all env var names that reference this secret
    const mapping = getConnectorEnvironmentMapping(type);
    const envVarNames = Object.entries(mapping)
      .filter(([, valueRef]) => valueRef === `$secrets.${secretName}`)
      .map(([envVar]) => envVar);

    if (envVarNames.length > 0) {
      return { connectorLabel: config.label, envVarNames };
    }
  }

  return null;
}

/**
 * Get the set of environment variable names that connected connectors can provide.
 * Used by pre-run checks to exclude connector-provided secrets from "missing" lists.
 *
 * Example: getConnectorProvidedSecretNames(["github"])
 * → Set { "GH_TOKEN", "GITHUB_TOKEN" }
 */
export function getConnectorProvidedSecretNames(
  connectedTypes: string[],
): Set<string> {
  const provided = new Set<string>();

  for (const rawType of connectedTypes) {
    const parsed = connectorTypeSchema.safeParse(rawType);
    if (!parsed.success) {
      continue;
    }
    const mapping = getConnectorEnvironmentMapping(parsed.data);
    for (const envVar of Object.keys(mapping)) {
      provided.add(envVar);
    }
  }

  return provided;
}

/**
 * Get OAuth configuration for a connector type
 */
export function getConnectorOAuthConfig(
  type: ConnectorType,
): ConnectorOAuthConfig | undefined {
  const config = CONNECTOR_TYPES[type];
  return "oauth" in config ? config.oauth : undefined;
}

/**
 * Check if stored OAuth scopes cover all required scopes for a connector type.
 * Returns true if no OAuth config exists (non-OAuth connector) or all required scopes are present.
 * Returns false if storedScopes is null (legacy connector) or missing any required scope.
 */
export function hasRequiredScopes(
  connectorType: ConnectorType,
  storedScopes: string[] | null,
): boolean {
  const oauthConfig = getConnectorOAuthConfig(connectorType);
  if (!oauthConfig) return true;
  if (oauthConfig.scopes.length === 0) return true;
  if (!storedScopes) return false;
  const storedSet = new Set(storedScopes);
  return oauthConfig.scopes.every((s) => storedSet.has(s));
}

/**
 * Compute the diff between currently required scopes and stored scopes for a connector.
 */
export interface ScopeDiff {
  addedScopes: string[];
  removedScopes: string[];
  currentScopes: string[];
  storedScopes: string[];
}

export function getScopeDiff(
  connectorType: ConnectorType,
  storedScopes: string[] | null,
): ScopeDiff {
  const oauthConfig = getConnectorOAuthConfig(connectorType);
  const currentScopes = oauthConfig?.scopes ?? [];
  const stored = storedScopes ?? [];
  const storedSet = new Set(stored);
  const currentSet = new Set(currentScopes);

  return {
    addedScopes: currentScopes.filter((s) => !storedSet.has(s)),
    removedScopes: stored.filter((s) => !currentSet.has(s)),
    currentScopes,
    storedScopes: stored,
  };
}

/**
 * Get all secret/variable names managed by connectors across ALL auth methods.
 * Unlike `getConnectorProvidedSecretNames` (which only reads environmentMapping),
 * this function also includes api-token auth method secrets.
 *
 * Used to hide connector-managed secrets from the secrets & variables list.
 */
export function getConnectorManagedSecretNames(
  types: ConnectorType[],
): Set<string> {
  const managed = new Set<string>();
  for (const type of types) {
    const config = CONNECTOR_TYPES[type];
    for (const method of Object.values(config.authMethods)) {
      for (const name of Object.keys(method.secrets)) {
        managed.add(name);
      }
    }
    // Also include environmentMapping keys (OAuth-derived env vars like GH_TOKEN)
    const mapping = getConnectorEnvironmentMapping(type);
    for (const envVar of Object.keys(mapping)) {
      managed.add(envVar);
    }
  }
  return managed;
}

/**
 * Reverse lookup: given a secret/env-var name, find which connector type manages it.
 * Checks both authMethods.secrets keys and environmentMapping keys.
 * Returns null if no connector manages this name.
 */
export function getConnectorTypeForSecretName(
  name: string,
): ConnectorType | null {
  const allTypes = Object.keys(CONNECTOR_TYPES) as ConnectorType[];
  for (const type of allTypes) {
    const config = CONNECTOR_TYPES[type];
    // Check authMethods secrets
    for (const method of Object.values(config.authMethods)) {
      if (name in method.secrets) {
        return type;
      }
    }
    // Check environmentMapping keys
    const mapping = getConnectorEnvironmentMapping(type);
    if (name in mapping) {
      return type;
    }
  }
  return null;
}

/**
 * Get required secret names for a connector's api-token auth method.
 * Returns null if the connector type does not support api-token auth.
 * Note: Returns ALL required field names regardless of storage type (secret or variable).
 */
export function getApiTokenRequiredSecretNames(
  type: ConnectorType,
): string[] | null {
  const config = CONNECTOR_TYPES[type];
  const apiTokenConfig = config.authMethods["api-token"] as
    | ConnectorAuthMethodConfig
    | undefined;
  if (!apiTokenConfig) return null;

  return Object.entries(apiTokenConfig.secrets)
    .filter(([, cfg]) => cfg.required)
    .map(([name]) => name);
}

/**
 * Get required field names grouped by storage type for a connector's api-token auth method.
 * Returns null if the connector type does not support api-token auth.
 */
export function getApiTokenFieldsByType(
  type: ConnectorType,
): { secrets: string[]; variables: string[] } | null {
  const config = CONNECTOR_TYPES[type];
  const apiTokenConfig = config.authMethods["api-token"] as
    | ConnectorAuthMethodConfig
    | undefined;
  if (!apiTokenConfig) return null;

  const secretNames: string[] = [];
  const variableNames: string[] = [];
  for (const [name, cfg] of Object.entries(apiTokenConfig.secrets)) {
    if (!cfg.required) continue;
    if (cfg.type === "variable") {
      variableNames.push(name);
    } else {
      secretNames.push(name);
    }
  }
  return { secrets: secretNames, variables: variableNames };
}

/**
 * Derive which connector types are "connected" via api-token based on present user secret and variable names.
 * A connector type is considered connected if all its required api-token fields exist
 * (secrets checked against userSecretNames, variables checked against userVariableNames).
 */
export function deriveApiTokenConnectedTypes(
  userSecretNames: Set<string>,
  userVariableNames?: Set<string>,
): ConnectorType[] {
  const allTypes = Object.keys(CONNECTOR_TYPES) as ConnectorType[];
  const connected: ConnectorType[] = [];
  const varNames = userVariableNames ?? new Set<string>();

  for (const type of allTypes) {
    const fields = getApiTokenFieldsByType(type);
    if (!fields) continue;
    if (fields.secrets.length === 0 && fields.variables.length === 0) continue;
    const secretsOk = fields.secrets.every((name) => userSecretNames.has(name));
    const variablesOk = fields.variables.every((name) => varNames.has(name));
    if (secretsOk && variablesOk) {
      connected.push(type);
    }
  }

  return connected;
}

/**
 * Connector response schema
 */
export const connectorResponseSchema = z.object({
  id: z.uuid().nullable(),
  type: connectorTypeSchema,
  authMethod: z.string(),
  externalId: z.string().nullable(),
  externalUsername: z.string().nullable(),
  externalEmail: z.string().nullable(),
  oauthScopes: z.array(z.string()).nullable(),
  needsReconnect: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ConnectorResponse = z.infer<typeof connectorResponseSchema>;

/**
 * List connectors response
 */
export const connectorListResponseSchema = z.object({
  connectors: z.array(connectorResponseSchema),
  configuredTypes: z.array(connectorTypeSchema),
  connectorProvidedSecretNames: z.array(z.string()),
});

export type ConnectorListResponse = z.infer<typeof connectorListResponseSchema>;

/**
 * Connectors main contract for /api/connectors
 */
export const connectorsMainContract = c.router({
  list: {
    method: "GET",
    path: "/api/connectors",
    headers: authHeadersSchema,
    responses: {
      200: connectorListResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List all connectors for the authenticated user",
  },
});

export type ConnectorsMainContract = typeof connectorsMainContract;

/**
 * Connector by type contract for /api/connectors/[type]
 */
export const connectorsByTypeContract = c.router({
  get: {
    method: "GET",
    path: "/api/connectors/:type",
    headers: authHeadersSchema,
    pathParams: z.object({
      type: connectorTypeSchema,
    }),
    responses: {
      200: connectorResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get connector status by type",
  },
  delete: {
    method: "DELETE",
    path: "/api/connectors/:type",
    headers: authHeadersSchema,
    pathParams: z.object({
      type: connectorTypeSchema,
    }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Disconnect a connector",
  },
});

export type ConnectorsByTypeContract = typeof connectorsByTypeContract;

/**
 * Scope diff response schema for /api/connectors/:type/scope-diff
 */
export const scopeDiffResponseSchema = z.object({
  addedScopes: z.array(z.string()),
  removedScopes: z.array(z.string()),
  currentScopes: z.array(z.string()),
  storedScopes: z.array(z.string()),
});

export type ScopeDiffResponse = z.infer<typeof scopeDiffResponseSchema>;

/**
 * Connector scope diff contract for /api/connectors/[type]/scope-diff
 */
export const connectorScopeDiffContract = c.router({
  getScopeDiff: {
    method: "GET",
    path: "/api/connectors/:type/scope-diff",
    headers: authHeadersSchema,
    pathParams: z.object({ type: connectorTypeSchema }),
    responses: {
      200: scopeDiffResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get scope diff for a connector",
  },
});

export type ConnectorScopeDiffContract = typeof connectorScopeDiffContract;

/**
 * Connector session status enum
 */
export const connectorSessionStatusSchema = z.enum([
  "pending",
  "complete",
  "expired",
  "error",
]);

export type ConnectorSessionStatus = z.infer<
  typeof connectorSessionStatusSchema
>;

/**
 * Connector session response schema
 */
export const connectorSessionResponseSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  type: connectorTypeSchema,
  status: connectorSessionStatusSchema,
  verificationUrl: z.string(),
  expiresIn: z.number(),
  interval: z.number(),
  errorMessage: z.string().nullable().optional(),
});

export type ConnectorSessionResponse = z.infer<
  typeof connectorSessionResponseSchema
>;

/**
 * Connector session status response (for polling)
 */
export const connectorSessionStatusResponseSchema = z.object({
  status: connectorSessionStatusSchema,
  errorMessage: z.string().nullable().optional(),
});

export type ConnectorSessionStatusResponse = z.infer<
  typeof connectorSessionStatusResponseSchema
>;

/**
 * Connector sessions contract for /api/connectors/[type]/sessions
 * Used for CLI device flow - initiate OAuth from CLI
 */
export const connectorSessionsContract = c.router({
  /**
   * POST /api/connectors/:type/sessions
   * Create a new connector session for CLI device flow
   */
  create: {
    method: "POST",
    path: "/api/connectors/:type/sessions",
    headers: authHeadersSchema,
    pathParams: z.object({
      type: connectorTypeSchema,
    }),
    body: z.object({}).optional(),
    responses: {
      200: connectorSessionResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create connector session for CLI device flow",
  },
});

export type ConnectorSessionsContract = typeof connectorSessionsContract;

/**
 * Connector session by ID contract for /api/connectors/[type]/sessions/[id]
 * Used for CLI polling to check session status
 */
export const connectorSessionByIdContract = c.router({
  /**
   * GET /api/connectors/:type/sessions/:sessionId
   * Get connector session status (for CLI polling)
   */
  get: {
    method: "GET",
    path: "/api/connectors/:type/sessions/:sessionId",
    headers: authHeadersSchema,
    pathParams: z.object({
      type: connectorTypeSchema,
      sessionId: z.uuid(),
    }),
    responses: {
      200: connectorSessionStatusResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get connector session status",
  },
});

export type ConnectorSessionByIdContract = typeof connectorSessionByIdContract;

/**
 * Computer connector create response
 */
export const computerConnectorCreateResponseSchema = z.object({
  id: z.uuid(),
  ngrokToken: z.string(),
  bridgeToken: z.string(),
  endpointPrefix: z.string(),
  domain: z.string(),
});

export type ComputerConnectorCreateResponse = z.infer<
  typeof computerConnectorCreateResponseSchema
>;

/**
 * Computer connector contract for /api/connectors/computer
 * Server-provisioned ngrok tunnel credentials (no OAuth flow)
 */
export const computerConnectorContract = c.router({
  create: {
    method: "POST",
    path: "/api/connectors/computer",
    headers: authHeadersSchema,
    body: z.object({}).optional(),
    responses: {
      200: computerConnectorCreateResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create computer connector with ngrok tunnel credentials",
  },
  get: {
    method: "GET",
    path: "/api/connectors/computer",
    headers: authHeadersSchema,
    responses: {
      200: connectorResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get computer connector status",
  },
  delete: {
    method: "DELETE",
    path: "/api/connectors/computer",
    headers: authHeadersSchema,
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete computer connector and revoke ngrok credentials",
  },
});

export type ComputerConnectorContract = typeof computerConnectorContract;
