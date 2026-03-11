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
        helpText:
          "1. Log in to your [Ahrefs Dashboard](https://app.ahrefs.com)\n2. Go to **API keys** under your account settings\n3. Generate a new API token\n4. Copy the token",
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
          "1. Log in to the [Hume Portal](https://platform.hume.ai)\n2. Navigate to the **API Keys** page\n3. Copy your API key",
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
        helpText:
          "1. Log in to [HeyGen](https://app.heygen.com)\n2. Go to **Settings → API**\n3. Copy your API key",
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
        helpText:
          '1. Go to [Dropbox App Console](https://www.dropbox.com/developers/apps)\n2. Select or create your app\n3. Under **Settings**, click "Generate" to create an access token\n4. Copy the token\n\n> **Note:** Generated tokens are short-lived (4 hours). You may need to regenerate periodically.',
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
      scopes: ["read", "write"],
      environmentMapping: {
        LINEAR_API_KEY: "$secrets.LINEAR_ACCESS_TOKEN",
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
        helpText:
          "1. Log in to your [Intercom workspace](https://app.intercom.com/)\n2. Navigate to **Settings** → **Developers** → **Developer Hub**\n3. Create a new app or select an existing one\n4. Go to **Configure** → **Authentication**\n5. Copy your **Access Token**",
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
        helpText:
          "1. Log in to [Make](https://www.make.com)\n2. Click your profile icon and go to **Profile**\n3. Scroll to the **API** section\n4. Click **Add token** and select the required scopes\n5. Copy the generated token",
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
        helpText:
          "1. Go to **Apps & Integrations > Developer Center** in Deel\n2. Navigate to the **Organization tokens** tab\n3. Create a new token with required scopes\n4. Copy the generated token",
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
        helpText:
          "1. Log in to [DeepSeek Platform](https://platform.deepseek.com)\n2. Go to **API Keys**\n3. Create a new API key\n4. Copy the key",
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
        helpText:
          "1. Log in to [ClickUp](https://app.clickup.com)\n2. Click your avatar in the bottom-left corner\n3. Go to **Settings** → **Apps**\n4. Under **API Token**, click **Generate** and copy it",
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
  dify: {
    label: "Dify",
    helpText:
      "Connect your Dify account to build and manage AI-powered workflows, chatbots, and agentic applications",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Dify](https://cloud.dify.ai)\n2. Open your application\n3. Go to **API Access** in the left sidebar\n4. Copy the API Key",
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
        helpText:
          "1. Go to [Figma Settings > Security](https://www.figma.com/settings#personal-access-tokens)\n2. Create a new personal access token\n3. Select required scopes (e.g., File content: Read/Write)\n4. Copy the generated token",
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
          "1. Log in to your [Mercury Dashboard](https://app.mercury.com)\n2. Go to **Settings** and find the API section\n3. Generate a new API token\n4. Copy the token",
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
        helpText:
          "1. Log in to the [MiniMax Platform](https://platform.minimaxi.com)\n2. Go to **Account → API Keys**\n3. Create a new API key and copy it",
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
        helpText:
          "1. Sign up at [Reportei](https://www.reportei.com/)\n2. Go to Dashboard → Generate API Token\n3. Copy the token",
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
        helpText:
          "1. Sign up at [SerpApi](https://serpapi.com/)\n2. Go to **Manage API Key** in the dashboard\n3. Copy your API key",
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
    featureFlag: FeatureSwitchKey.StravaConnector,
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
        helpText:
          '1. Go to [Neon Console > Account Settings > API Keys](https://console.neon.tech/app/settings/api-keys)\n2. Click "Create new API key"\n3. Copy the generated key',
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
        helpText:
          "1. Log in to your [PostHog Dashboard](https://us.posthog.com)\n2. Go to **Settings → Personal API keys**\n3. Click **+ Create personal API key**\n4. Select the scopes you need and copy the key",
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
        helpText:
          "1. Log in to your [Productlane Dashboard](https://productlane.com)\n2. Go to **Settings → API**\n3. Copy your API key",
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
        helpText:
          "1. Go to [Intervals.icu Settings > Developer Settings](https://intervals.icu/settings)\n2. Scroll to the bottom to find **Developer Settings**\n3. Generate or copy your API key",
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
        helpText:
          '1. Go to [Supabase Dashboard > Project Settings > API](https://supabase.com/dashboard/project/_/settings/api)\n2. Find the **service_role** key under "Project API keys"\n3. Copy the key\n\n> **Note:** The service_role key bypasses Row Level Security. Keep it secret.',
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
        helpText:
          '1. Go to your Webflow site\'s **Settings > Apps & integrations > API access**\n2. Click "Generate API token"\n3. Select required scopes\n4. Copy the generated token\n\n> Tokens expire after 365 days of inactivity.',
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
        helpText:
          "1. Log in to your [Wrike account](https://www.wrike.com/)\n2. Navigate to **Apps & Integrations** → **API**\n3. Click **Create new** under **Permanent access tokens**\n4. Copy the generated token",
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
        STRIPE_API_KEY: "$secrets.STRIPE_ACCESS_TOKEN",
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
        helpText:
          "1. Log in to [OpenAI](https://platform.openai.com)\n2. Go to **API keys** in the left sidebar\n3. Click **Create new secret key**\n4. Copy the key",
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
        helpText:
          "1. Log in to [SimilarWeb](https://www.similarweb.com)\n2. Go to **Settings > Account > API Keys**\n3. Generate and activate an API key\n4. Copy the key",
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
        helpText:
          "1. Log in to [Perplexity](https://www.perplexity.ai)\n2. Go to **Settings → API**\n3. Generate a new API key\n4. Copy the key",
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
        helpText:
          "1. Log in to your [Mailchimp account](https://login.mailchimp.com)\n2. Go to **Account & Billing** → **Extras** → **API keys**\n3. Click **Create A Key**\n4. Copy the API key (format: `xxxxxxxx-us00`)",
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
        helpText:
          "1. Log in to your [Chatwoot](https://app.chatwoot.com) instance\n2. Go to **Settings > Account Settings**\n3. Find **Access Token** in the profile section\n4. Copy the token",
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
        helpText:
          "1. Log in to [Resend](https://resend.com)\n2. Go to **API Keys** in the sidebar\n3. Click **Create API Key**\n4. Choose permissions (Full access recommended) and copy the key",
        secrets: {
          RESEND_API_KEY: {
            label: "API Key",
            required: true,
            placeholder: "re_xxxxxxxxxx",
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
        helpText:
          "1. Log in to [PDF4me](https://dev.pdf4me.com)\n2. Go to your **Dashboard → API Keys**\n3. Copy your API key",
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
  "bright-data": {
    label: "Bright Data",
    helpText:
      "Connect your Bright Data account to scrape websites, manage proxies, and access web data",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Bright Data](https://brightdata.com/cp)\n2. Go to **Settings > Users**\n3. Copy your **API token**",
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
        helpText:
          "1. Log in to [Browserbase](https://www.browserbase.com)\n2. Go to **Dashboard > Settings**\n3. Copy your **API Key** and **Project ID**",
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
        helpText:
          "1. Log in to [Browserless](https://account.browserless.io)\n2. Copy your **API Token** from the dashboard",
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
        helpText:
          "1. Sign up at [RapidAPI](https://rapidapi.com/restyler/api/scrapeninja) or [APIRoad](https://apiroad.net/marketplace/apis/scrapeninja)\n2. Subscribe to the ScrapeNinja API\n3. Copy your **API Key**",
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
        helpText:
          "1. Log in to [PDF.co](https://app.pdf.co)\n2. Find your API key on the dashboard\n3. Copy the key",
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
        helpText:
          "1. Log in to [ElevenLabs](https://elevenlabs.io)\n2. Click your profile icon → **Profile + API key**\n3. Copy your API key",
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
  devto: {
    label: "Dev.to",
    helpText:
      "Connect your Dev.to account to publish articles, manage posts, and interact with the developer community",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Dev.to](https://dev.to)\n2. Go to **Settings → Extensions**\n3. Scroll to **DEV Community API Keys**\n4. Generate a new API key and copy it",
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
        helpText:
          "1. Log in to [fal.ai](https://fal.ai/dashboard)\n2. Go to **Keys** in the sidebar\n3. Click **Create Key**\n4. Copy the key",
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
  podchaser: {
    label: "Podchaser",
    helpText:
      "Connect your Podchaser account to search podcasts, episodes, creators, and access podcast industry data",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Podchaser](https://www.podchaser.com)\n2. Go to **Account Settings → API**\n3. Use your client ID and secret to request an access token via the `requestAccessToken` mutation\n4. Copy the access token",
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
        helpText:
          "1. Sign up at [Pushinator](https://pushinator.com/)\n2. Go to the [Console](https://console.pushinator.com/tokens)\n3. Generate an API token\n4. Copy the token",
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
          "1. Log in to [Qdrant Cloud](https://cloud.qdrant.io)\n2. Go to **Data Access Control → API Keys**\n3. Create a new API key\n4. Copy the key",
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
        helpText:
          "1. Log in to [Qiita](https://qiita.com)\n2. Go to **Settings → Applications → Personal access tokens**\n3. Generate a new token with required scopes\n4. Copy the token",
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
        helpText:
          "1. Log in to [ZeptoMail](https://zeptomail.zoho.com)\n2. Go to **Agents → SMTP/API**\n3. Under **Send Mail Token**, click the copy icon",
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
        helpText:
          "1. Sign up at [Runway Developer Portal](https://dev.runwayml.com/)\n2. Purchase credits and create an API key in the dashboard\n3. Copy the API key",
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
        helpText:
          "1. Sign up at [Short.io](https://short.io/)\n2. Go to **Integrations & API** in Settings\n3. Copy your API key",
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
        helpText:
          "1. Log in to [Streak](https://streak.com/)\n2. Go to **Settings → Integrations & API**\n3. Copy your API key",
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
        helpText:
          "1. Sign up at [Supadata](https://supadata.ai/)\n2. Go to the dashboard and copy your API key",
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
        helpText:
          "1. Sign up at [Tavily](https://tavily.com/)\n2. Go to the dashboard and copy your API key",
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
  twenty: {
    label: "Twenty",
    helpText:
      "Connect your Twenty CRM account to manage contacts, companies, and deals",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Twenty](https://twenty.com/)\n2. Go to **Settings → APIs & Webhooks**\n3. Generate an API key and copy it",
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
  zapsign: {
    label: "ZapSign",
    helpText:
      "Connect your ZapSign account to create documents for electronic signature and track signing status",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [ZapSign](https://app.zapsign.com.br/)\n2. Go to **Settings → Integrations → API**\n3. Copy your API token",
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
} satisfies Record<string, ConnectorConfig>;

export type ConnectorType = keyof typeof CONNECTOR_TYPES_DEF;

export const CONNECTOR_TYPES: Record<ConnectorType, ConnectorConfig> =
  CONNECTOR_TYPES_DEF;

/**
 * Proxy-side connector configuration for token replacement.
 *
 * Defines which base URLs each connector covers and how auth headers
 * are constructed. Used by the proxy to intercept requests matching a
 * connector's base URLs and replace placeholder tokens with real credentials.
 *
 * `${secrets.XXX}` in header values is replaced by the proxy with the real secret value.
 *
 * NOTE: Currently hardcoded in CONNECTOR_PROXY_CONFIGS below.
 * Will be migrated to GitHub-hosted connector.yaml definitions in Phase 2.
 */
interface ConnectorService {
  base: string;
  auth: {
    headers: Record<string, string>;
  };
}

export interface ConnectorProxyConfig {
  services: ConnectorService[];
  /** Custom placeholder values per env var (e.g., `{ GITHUB_TOKEN: "gho_..." }`). Falls back to auto-generated `VM0_PLACEHOLDER_{envVar}`. */
  placeholders?: Record<string, string>;
}

/** Helper to build standard Bearer auth header with a secret reference. */
function bearerAuth(secretName: string) {
  return { headers: { Authorization: `Bearer \${secrets.${secretName}}` } };
}

/** Shorthand: single-base service with bearer auth. */
function service(
  base: string,
  auth: ConnectorService["auth"],
): ConnectorService {
  return { base, auth };
}

const CONNECTOR_PROXY_CONFIGS: Partial<
  Record<ConnectorType, ConnectorProxyConfig>
> = {
  ahrefs: {
    services: [service("https://api.ahrefs.com", bearerAuth("AHREFS_API_KEY"))],
  },
  axiom: {
    services: [service("https://api.axiom.co", bearerAuth("AXIOM_API_TOKEN"))],
  },
  airtable: {
    services: [
      service("https://api.airtable.com", bearerAuth("AIRTABLE_TOKEN")),
    ],
  },
  github: {
    services: [service("https://api.github.com", bearerAuth("GITHUB_TOKEN"))],
    placeholders: {
      GH_TOKEN: "gho_vm0placeholder0000000000000000000000",
      GITHUB_TOKEN: "gho_vm0placeholder0000000000000000000000",
    },
  },
  notion: {
    services: [
      service("https://api.notion.com/v1", {
        headers: {
          Authorization: "Bearer ${secrets.NOTION_TOKEN}",
          "Notion-Version": "2022-06-28",
        },
      }),
    ],
  },
  gmail: {
    services: [
      service(
        "https://gmail.googleapis.com/gmail/v1/users/me",
        bearerAuth("GMAIL_TOKEN"),
      ),
    ],
  },
  "google-sheets": {
    services: [
      service(
        "https://sheets.googleapis.com/v4/spreadsheets",
        bearerAuth("GOOGLE_SHEETS_TOKEN"),
      ),
    ],
  },
  "google-docs": {
    services: [
      service(
        "https://docs.googleapis.com/v1/documents",
        bearerAuth("GOOGLE_DOCS_TOKEN"),
      ),
    ],
  },
  "google-drive": {
    services: [
      service(
        "https://www.googleapis.com/drive/v3",
        bearerAuth("GOOGLE_DRIVE_TOKEN"),
      ),
    ],
  },
  "google-calendar": {
    services: [
      service(
        "https://www.googleapis.com/calendar/v3",
        bearerAuth("GOOGLE_CALENDAR_TOKEN"),
      ),
    ],
  },
  "hugging-face": {
    services: [
      service("https://huggingface.co/api", bearerAuth("HUGGING_FACE_TOKEN")),
    ],
  },
  hume: {
    services: [
      service("https://api.hume.ai", {
        headers: { "X-Hume-Api-Key": "${secrets.HUME_TOKEN}" },
      }),
    ],
  },
  heygen: {
    services: [
      service("https://api.heygen.com", {
        headers: { "x-api-key": "${secrets.HEYGEN_TOKEN}" },
      }),
    ],
  },
  hubspot: {
    services: [service("https://api.hubapi.com", bearerAuth("HUBSPOT_TOKEN"))],
  },
  slack: {
    services: [
      service("https://slack.com/api", bearerAuth("SLACK_TOKEN")),
      service("https://files.slack.com", bearerAuth("SLACK_TOKEN")),
    ],
    placeholders: {
      SLACK_TOKEN: "xoxb-0000-0000-vm0placeholder",
    },
  },
  docusign: {
    services: [
      service(
        "https://demo.docusign.net/restapi",
        bearerAuth("DOCUSIGN_TOKEN"),
      ),
      service("https://na1.docusign.net/restapi", bearerAuth("DOCUSIGN_TOKEN")),
    ],
  },
  dropbox: {
    services: [
      service("https://api.dropboxapi.com/2", bearerAuth("DROPBOX_TOKEN")),
      service("https://content.dropboxapi.com/2", bearerAuth("DROPBOX_TOKEN")),
    ],
  },
  linear: {
    services: [service("https://api.linear.app", bearerAuth("LINEAR_API_KEY"))],
  },
  intercom: {
    services: [
      service("https://api.intercom.io", bearerAuth("INTERCOM_TOKEN")),
      service("https://api.eu.intercom.io", bearerAuth("INTERCOM_TOKEN")),
      service("https://api.au.intercom.io", bearerAuth("INTERCOM_TOKEN")),
    ],
  },
  line: {
    services: [service("https://api.line.me", bearerAuth("LINE_TOKEN"))],
  },
  make: {
    services: [
      service("https://eu1.make.com/api/v2", {
        headers: {
          Authorization: "Token ${secrets.MAKE_TOKEN}",
        },
      }),
      service("https://eu2.make.com/api/v2", {
        headers: {
          Authorization: "Token ${secrets.MAKE_TOKEN}",
        },
      }),
      service("https://us1.make.com/api/v2", {
        headers: {
          Authorization: "Token ${secrets.MAKE_TOKEN}",
        },
      }),
      service("https://us2.make.com/api/v2", {
        headers: {
          Authorization: "Token ${secrets.MAKE_TOKEN}",
        },
      }),
    ],
  },
  clickup: {
    services: [
      service("https://api.clickup.com/api/v2", bearerAuth("CLICKUP_TOKEN")),
    ],
  },
  cloudflare: {
    services: [
      service(
        "https://api.cloudflare.com/client/v4",
        bearerAuth("CLOUDFLARE_TOKEN"),
      ),
    ],
  },
  deel: {
    services: [service("https://api.deel.com", bearerAuth("DEEL_TOKEN"))],
  },
  deepseek: {
    services: [
      service("https://api.deepseek.com", bearerAuth("DEEPSEEK_TOKEN")),
    ],
  },
  dify: {
    services: [service("https://api.dify.ai/v1", bearerAuth("DIFY_TOKEN"))],
  },
  figma: {
    services: [service("https://api.figma.com", bearerAuth("FIGMA_TOKEN"))],
  },
  mercury: {
    services: [service("https://api.mercury.com", bearerAuth("MERCURY_TOKEN"))],
  },
  minimax: {
    services: [
      service("https://api.minimaxi.com/v1", bearerAuth("MINIMAX_TOKEN")),
    ],
  },
  reddit: {
    services: [service("https://oauth.reddit.com", bearerAuth("REDDIT_TOKEN"))],
  },
  strava: {
    services: [
      service("https://www.strava.com/api/v3", bearerAuth("STRAVA_TOKEN")),
    ],
  },
  x: {
    services: [service("https://api.x.com/2", bearerAuth("X_ACCESS_TOKEN"))],
  },
  neon: {
    services: [
      service("https://console.neon.tech/api/v2", bearerAuth("NEON_API_KEY")),
    ],
  },
  vercel: {
    services: [service("https://api.vercel.com", bearerAuth("VERCEL_TOKEN"))],
  },
  sentry: {
    services: [service("https://sentry.io/api", bearerAuth("SENTRY_TOKEN"))],
  },
  monday: {
    services: [
      service("https://api.monday.com/v2", bearerAuth("MONDAY_TOKEN")),
    ],
  },
  canva: {
    services: [
      service("https://api.canva.com/rest/v1", bearerAuth("CANVA_TOKEN")),
    ],
  },
  xero: {
    services: [service("https://api.xero.com", bearerAuth("XERO_TOKEN"))],
  },
  supabase: {
    services: [
      service("https://api.supabase.com/v1", bearerAuth("SUPABASE_TOKEN")),
    ],
  },
  todoist: {
    services: [
      service("https://api.todoist.com/rest/v2", bearerAuth("TODOIST_TOKEN")),
    ],
  },
  webflow: {
    services: [
      service("https://api.webflow.com/v2", bearerAuth("WEBFLOW_TOKEN")),
    ],
  },
  asana: {
    services: [
      service("https://app.asana.com/api/1.0", bearerAuth("ASANA_TOKEN")),
    ],
  },
  "meta-ads": {
    services: [
      service("https://graph.facebook.com", bearerAuth("META_ADS_TOKEN")),
    ],
  },
  posthog: {
    services: [
      service("https://us.posthog.com/api", bearerAuth("POSTHOG_ACCESS_TOKEN")),
      service(
        "https://app.posthog.com/api",
        bearerAuth("POSTHOG_ACCESS_TOKEN"),
      ),
    ],
  },
  stripe: {
    services: [service("https://api.stripe.com", bearerAuth("STRIPE_API_KEY"))],
  },
  productlane: {
    services: [
      service(
        "https://productlane.com/api/v1",
        bearerAuth("PRODUCTLANE_TOKEN"),
      ),
    ],
  },
  openai: {
    services: [service("https://api.openai.com", bearerAuth("OPENAI_TOKEN"))],
  },
  similarweb: {
    services: [
      service("https://api.similarweb.com", {
        headers: { "api-key": "${secrets.SIMILARWEB_API_KEY}" },
      }),
    ],
  },
  perplexity: {
    services: [
      service("https://api.perplexity.ai", bearerAuth("PERPLEXITY_TOKEN")),
    ],
  },
  plausible: {
    services: [
      service("https://plausible.io/api", bearerAuth("PLAUSIBLE_TOKEN")),
    ],
  },
  mailchimp: {
    services: [
      service(
        "https://us1.api.mailchimp.com/3.0",
        bearerAuth("MAILCHIMP_API_KEY"),
      ),
      service(
        "https://us2.api.mailchimp.com/3.0",
        bearerAuth("MAILCHIMP_API_KEY"),
      ),
      service(
        "https://us3.api.mailchimp.com/3.0",
        bearerAuth("MAILCHIMP_API_KEY"),
      ),
      service(
        "https://us4.api.mailchimp.com/3.0",
        bearerAuth("MAILCHIMP_API_KEY"),
      ),
      service(
        "https://us5.api.mailchimp.com/3.0",
        bearerAuth("MAILCHIMP_API_KEY"),
      ),
      service(
        "https://us6.api.mailchimp.com/3.0",
        bearerAuth("MAILCHIMP_API_KEY"),
      ),
      service(
        "https://us7.api.mailchimp.com/3.0",
        bearerAuth("MAILCHIMP_API_KEY"),
      ),
      service(
        "https://us8.api.mailchimp.com/3.0",
        bearerAuth("MAILCHIMP_API_KEY"),
      ),
      service(
        "https://us9.api.mailchimp.com/3.0",
        bearerAuth("MAILCHIMP_API_KEY"),
      ),
      service(
        "https://us10.api.mailchimp.com/3.0",
        bearerAuth("MAILCHIMP_API_KEY"),
      ),
      service(
        "https://us11.api.mailchimp.com/3.0",
        bearerAuth("MAILCHIMP_API_KEY"),
      ),
      service(
        "https://us12.api.mailchimp.com/3.0",
        bearerAuth("MAILCHIMP_API_KEY"),
      ),
      service(
        "https://us13.api.mailchimp.com/3.0",
        bearerAuth("MAILCHIMP_API_KEY"),
      ),
      service(
        "https://us14.api.mailchimp.com/3.0",
        bearerAuth("MAILCHIMP_API_KEY"),
      ),
      service(
        "https://us15.api.mailchimp.com/3.0",
        bearerAuth("MAILCHIMP_API_KEY"),
      ),
      service(
        "https://us16.api.mailchimp.com/3.0",
        bearerAuth("MAILCHIMP_API_KEY"),
      ),
      service(
        "https://us17.api.mailchimp.com/3.0",
        bearerAuth("MAILCHIMP_API_KEY"),
      ),
      service(
        "https://us18.api.mailchimp.com/3.0",
        bearerAuth("MAILCHIMP_API_KEY"),
      ),
      service(
        "https://us19.api.mailchimp.com/3.0",
        bearerAuth("MAILCHIMP_API_KEY"),
      ),
      service(
        "https://us20.api.mailchimp.com/3.0",
        bearerAuth("MAILCHIMP_API_KEY"),
      ),
      service(
        "https://us21.api.mailchimp.com/3.0",
        bearerAuth("MAILCHIMP_API_KEY"),
      ),
    ],
  },
  chatwoot: {
    services: [
      service("https://app.chatwoot.com", bearerAuth("CHATWOOT_TOKEN")),
    ],
  },
  resend: {
    services: [service("https://api.resend.com", bearerAuth("RESEND_API_KEY"))],
  },
  pdf4me: {
    services: [
      service("https://api.pdf4me.com", {
        headers: { Authorization: "${secrets.PDF4ME_TOKEN}" },
      }),
    ],
  },
  pdfco: {
    services: [
      service("https://api.pdf.co/v1", {
        headers: { "x-api-key": "${secrets.PDFCO_TOKEN}" },
      }),
    ],
  },
  apify: {
    services: [service("https://api.apify.com/v2", bearerAuth("APIFY_TOKEN"))],
  },
  "bright-data": {
    services: [
      service("https://api.brightdata.com", bearerAuth("BRIGHTDATA_TOKEN")),
    ],
  },
  browserbase: {
    services: [
      service("https://api.browserbase.com/v1", {
        headers: { "X-BB-API-Key": "${secrets.BROWSERBASE_TOKEN}" },
      }),
    ],
  },
  firecrawl: {
    services: [
      service("https://api.firecrawl.dev/v1", bearerAuth("FIRECRAWL_TOKEN")),
    ],
  },
  scrapeninja: {
    services: [
      service("https://scrapeninja.p.rapidapi.com", {
        headers: { "X-RapidAPI-Key": "${secrets.SCRAPENINJA_TOKEN}" },
      }),
    ],
  },
  elevenlabs: {
    services: [
      service("https://api.elevenlabs.io", {
        headers: { "xi-api-key": "${secrets.ELEVENLABS_TOKEN}" },
      }),
    ],
  },
  devto: {
    services: [
      service("https://dev.to/api", {
        headers: { "api-key": "${secrets.DEVTO_TOKEN}" },
      }),
    ],
  },
  fal: {
    services: [service("https://fal.run", bearerAuth("FAL_KEY"))],
  },
  podchaser: {
    services: [
      service("https://api.podchaser.com", bearerAuth("PODCHASER_TOKEN")),
    ],
  },
  pushinator: {
    services: [
      service("https://api.pushinator.com", bearerAuth("PUSHINATOR_TOKEN")),
    ],
  },
  qdrant: {
    services: [
      service("https://cloud.qdrant.io", {
        headers: { "api-key": "${secrets.QDRANT_TOKEN}" },
      }),
    ],
  },
  qiita: {
    services: [service("https://qiita.com/api/v2", bearerAuth("QIITA_TOKEN"))],
  },
  reportei: {
    services: [
      service("https://app.reportei.com/api/v1", bearerAuth("REPORTEI_TOKEN")),
    ],
  },
  zeptomail: {
    services: [
      service("https://api.zeptomail.com/v1.1", {
        headers: {
          Authorization: "Zoho-enczapikey ${secrets.ZEPTOMAIL_TOKEN}",
        },
      }),
    ],
  },
  runway: {
    services: [
      service("https://api.dev.runwayml.com/v1", bearerAuth("RUNWAY_TOKEN")),
    ],
  },
  shortio: {
    services: [
      service("https://api.short.io", {
        headers: { Authorization: "${secrets.SHORTIO_TOKEN}" },
      }),
    ],
  },
  supadata: {
    services: [
      service("https://api.supadata.ai/v1", {
        headers: { "x-api-key": "${secrets.SUPADATA_TOKEN}" },
      }),
    ],
  },
  tavily: {
    services: [service("https://api.tavily.com", bearerAuth("TAVILY_TOKEN"))],
  },
  twenty: {
    services: [service("https://api.twenty.com", bearerAuth("TWENTY_TOKEN"))],
  },
  wrike: {
    services: [
      service("https://www.wrike.com/api/v4", bearerAuth("WRIKE_TOKEN")),
    ],
  },
  zapsign: {
    services: [
      service("https://api.zapsign.com.br/api/v1", bearerAuth("ZAPSIGN_TOKEN")),
    ],
  },
};

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
  "line",
  "make",
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
  "pdf4me",
  "apify",
  "bright-data",
  "browserbase",
  "browserless",
  "firecrawl",
  "scrapeninja",
  "elevenlabs",
  "devto",
  "fal",
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
  "twenty",
  "youtube",
  "wrike",
  "zapsign",
  "zendesk",
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
 * Get proxy config for a connector type (base URLs + auth headers).
 * Returns undefined if the connector has no proxy config (e.g., computer connector).
 */
export function getConnectorProxyConfig(
  type: ConnectorType,
): ConnectorProxyConfig | undefined {
  return CONNECTOR_PROXY_CONFIGS[type];
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
  id: z.string().uuid().nullable(),
  type: connectorTypeSchema,
  authMethod: z.string(),
  externalId: z.string().nullable(),
  externalUsername: z.string().nullable(),
  externalEmail: z.string().nullable(),
  oauthScopes: z.array(z.string()).nullable(),
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
  id: z.string().uuid(),
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
      sessionId: z.string().uuid(),
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
  id: z.string().uuid(),
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
