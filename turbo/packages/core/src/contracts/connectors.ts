import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Secret field configuration for connector auth methods
 */
export interface ConnectorSecretConfig {
  label: string;
  required: boolean;
  placeholder?: string;
  helpText?: string;
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
 * OAuth configuration for connectors that support OAuth flow
 */
export interface ConnectorOAuthConfig {
  authorizationUrl?: string;
  tokenUrl: string;
  scopes: string[];
}

/**
 * Connector type configuration
 * Maps type to display info, auth methods, and environment mapping
 *
 * For connectors with `environmentMapping`, secrets are mapped to environment variables:
 * - `$secrets.X` - lookup secret X from the connector's secrets
 * - Other values are passed through as literals
 */
export const CONNECTOR_TYPES = {
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
    environmentMapping: {
      AIRTABLE_TOKEN: "$secrets.AIRTABLE_ACCESS_TOKEN",
    } as Record<string, string>,
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
    environmentMapping: {
      GH_TOKEN: "$secrets.GITHUB_ACCESS_TOKEN",
      GITHUB_TOKEN: "$secrets.GITHUB_ACCESS_TOKEN",
    } as Record<string, string>,
    oauth: {
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["repo", "project"],
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
    environmentMapping: {
      NOTION_TOKEN: "$secrets.NOTION_ACCESS_TOKEN",
    } as Record<string, string>,
    oauth: {
      authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
      tokenUrl: "https://api.notion.com/v1/oauth/token",
      scopes: [],
    } as ConnectorOAuthConfig,
  },
  gmail: {
    label: "Gmail",
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
    environmentMapping: {
      GMAIL_TOKEN: "$secrets.GMAIL_ACCESS_TOKEN",
    } as Record<string, string>,
    oauth: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    } as ConnectorOAuthConfig,
  },
  "google-sheets": {
    label: "Google Sheets",
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
    environmentMapping: {
      GOOGLE_SHEETS_TOKEN: "$secrets.GOOGLE_SHEETS_ACCESS_TOKEN",
    } as Record<string, string>,
    oauth: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
    } as ConnectorOAuthConfig,
  },
  "google-docs": {
    label: "Google Docs",
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
    environmentMapping: {
      GOOGLE_DOCS_TOKEN: "$secrets.GOOGLE_DOCS_ACCESS_TOKEN",
    } as Record<string, string>,
    oauth: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: [
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
    } as ConnectorOAuthConfig,
  },
  "google-drive": {
    label: "Google Drive",
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
    environmentMapping: {
      GOOGLE_DRIVE_TOKEN: "$secrets.GOOGLE_DRIVE_ACCESS_TOKEN",
    } as Record<string, string>,
    oauth: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
    } as ConnectorOAuthConfig,
  },
  "google-calendar": {
    label: "Google Calendar",
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
    environmentMapping: {
      GOOGLE_CALENDAR_TOKEN: "$secrets.GOOGLE_CALENDAR_ACCESS_TOKEN",
    } as Record<string, string>,
    oauth: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: [
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
    } as ConnectorOAuthConfig,
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
    environmentMapping: {
      HUBSPOT_TOKEN: "$secrets.HUBSPOT_ACCESS_TOKEN",
    } as Record<string, string>,
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
    } as ConnectorOAuthConfig,
  },
  computer: {
    label: "Computer",
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
    environmentMapping: {
      COMPUTER_CONNECTOR_BRIDGE_TOKEN:
        "$secrets.COMPUTER_CONNECTOR_BRIDGE_TOKEN",
      COMPUTER_CONNECTOR_DOMAIN: "$secrets.COMPUTER_CONNECTOR_DOMAIN",
    } as Record<string, string>,
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
    environmentMapping: {
      SLACK_TOKEN: "$secrets.SLACK_ACCESS_TOKEN",
    } as Record<string, string>,
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
    } as ConnectorOAuthConfig,
  },
  docusign: {
    label: "DocuSign",
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
    environmentMapping: {
      DOCUSIGN_TOKEN: "$secrets.DOCUSIGN_ACCESS_TOKEN",
    } as Record<string, string>,
    oauth: {
      authorizationUrl: "https://account.docusign.com/oauth/auth",
      tokenUrl: "https://account.docusign.com/oauth/token",
      scopes: ["signature", "extended", "openid"],
    } as ConnectorOAuthConfig,
  },
  dropbox: {
    label: "Dropbox",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    environmentMapping: {
      DROPBOX_TOKEN: "$secrets.DROPBOX_ACCESS_TOKEN",
    } as Record<string, string>,
    oauth: {
      authorizationUrl: "https://www.dropbox.com/oauth2/authorize",
      tokenUrl: "https://api.dropboxapi.com/oauth2/token",
      scopes: [
        "account_info.read",
        "files.metadata.read",
        "files.content.read",
      ],
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
    environmentMapping: {
      LINEAR_API_KEY: "$secrets.LINEAR_ACCESS_TOKEN",
    } as Record<string, string>,
    oauth: {
      authorizationUrl: "https://linear.app/oauth/authorize",
      tokenUrl: "https://api.linear.app/oauth/token",
      scopes: ["read", "write"],
    } as ConnectorOAuthConfig,
  },
  deel: {
    label: "Deel",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    environmentMapping: {
      DEEL_TOKEN: "$secrets.DEEL_ACCESS_TOKEN",
    } as Record<string, string>,
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
    } as ConnectorOAuthConfig,
  },
  figma: {
    label: "Figma",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    environmentMapping: {
      FIGMA_TOKEN: "$secrets.FIGMA_ACCESS_TOKEN",
    } as Record<string, string>,
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
    } as ConnectorOAuthConfig,
  },
  mercury: {
    label: "Mercury",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    environmentMapping: {
      MERCURY_TOKEN: "$secrets.MERCURY_ACCESS_TOKEN",
    } as Record<string, string>,
    oauth: {
      authorizationUrl: "https://oauth2.mercury.com/oauth2/auth",
      tokenUrl: "https://oauth2.mercury.com/oauth2/token",
      scopes: ["offline_access"],
    } as ConnectorOAuthConfig,
  },
  reddit: {
    label: "Reddit",
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
    environmentMapping: {
      REDDIT_TOKEN: "$secrets.REDDIT_ACCESS_TOKEN",
    } as Record<string, string>,
    oauth: {
      authorizationUrl: "https://www.reddit.com/api/v1/authorize",
      tokenUrl: "https://www.reddit.com/api/v1/access_token",
      scopes: ["identity", "read"],
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
    environmentMapping: {
      STRAVA_TOKEN: "$secrets.STRAVA_ACCESS_TOKEN",
    } as Record<string, string>,
    oauth: {
      authorizationUrl: "https://www.strava.com/oauth/authorize",
      tokenUrl: "https://www.strava.com/oauth/token",
      scopes: [
        "read",
        "profile:read_all",
        "activity:read_all",
        "activity:write",
      ],
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
    environmentMapping: {
      X_ACCESS_TOKEN: "$secrets.X_ACCESS_TOKEN",
    } as Record<string, string>,
    oauth: {
      authorizationUrl: "https://twitter.com/i/oauth2/authorize",
      tokenUrl: "https://api.twitter.com/2/oauth2/token",
      scopes: ["tweet.read", "users.read", "follows.read", "offline.access"],
    } as ConnectorOAuthConfig,
  },
  neon: {
    label: "Neon",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    environmentMapping: {
      NEON_API_KEY: "$secrets.NEON_ACCESS_TOKEN",
    } as Record<string, string>,
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
    } as ConnectorOAuthConfig,
  },
  "garmin-connect": {
    label: "Garmin Connect",
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
    environmentMapping: {
      GARMIN_CONNECT_TOKEN: "$secrets.GARMIN_CONNECT_ACCESS_TOKEN",
    } as Record<string, string>,
    oauth: {
      authorizationUrl: "https://connect.garmin.com/oauth2Confirm",
      tokenUrl: "https://diauth.garmin.com/di-oauth2-service/oauth/token",
      scopes: [],
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
    environmentMapping: {
      VERCEL_TOKEN: "$secrets.VERCEL_ACCESS_TOKEN",
    } as Record<string, string>,
    oauth: {
      tokenUrl: "https://api.vercel.com/v2/oauth/access_token",
      scopes: [],
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
    environmentMapping: {
      SENTRY_TOKEN: "$secrets.SENTRY_ACCESS_TOKEN",
    } as Record<string, string>,
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
    } as ConnectorOAuthConfig,
  },
  "intervals-icu": {
    label: "Intervals.icu",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    environmentMapping: {
      INTERVALS_ICU_TOKEN: "$secrets.INTERVALS_ICU_ACCESS_TOKEN",
    } as Record<string, string>,
    oauth: {
      authorizationUrl: "https://intervals.icu/oauth/authorize",
      tokenUrl: "https://intervals.icu/api/oauth/token",
      scopes: ["ACTIVITY", "WELLNESS", "CALENDAR", "SETTINGS", "LIBRARY"],
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
    environmentMapping: {
      MONDAY_TOKEN: "$secrets.MONDAY_ACCESS_TOKEN",
    } as Record<string, string>,
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
    } as ConnectorOAuthConfig,
  },
  canva: {
    label: "Canva",
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
    environmentMapping: {
      CANVA_TOKEN: "$secrets.CANVA_ACCESS_TOKEN",
    } as Record<string, string>,
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
    environmentMapping: {
      XERO_TOKEN: "$secrets.XERO_ACCESS_TOKEN",
    } as Record<string, string>,
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
    } as ConnectorOAuthConfig,
  },
  supabase: {
    label: "Supabase",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    environmentMapping: {
      SUPABASE_TOKEN: "$secrets.SUPABASE_ACCESS_TOKEN",
    } as Record<string, string>,
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
    environmentMapping: {
      TODOIST_TOKEN: "$secrets.TODOIST_ACCESS_TOKEN",
    } as Record<string, string>,
    oauth: {
      authorizationUrl: "https://todoist.com/oauth/authorize",
      tokenUrl: "https://todoist.com/oauth/access_token",
      scopes: ["data:read_write", "data:delete", "project:delete"],
    } as ConnectorOAuthConfig,
  },
  webflow: {
    label: "Webflow",
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
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    environmentMapping: {
      WEBFLOW_TOKEN: "$secrets.WEBFLOW_ACCESS_TOKEN",
    } as Record<string, string>,
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
    } as ConnectorOAuthConfig,
  },
  "meta-ads": {
    label: "Meta Ads",
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
    environmentMapping: {
      META_ADS_TOKEN: "$secrets.META_ADS_ACCESS_TOKEN",
    } as Record<string, string>,
    oauth: {
      authorizationUrl: "https://www.facebook.com/v22.0/dialog/oauth",
      tokenUrl: "https://graph.facebook.com/v22.0/oauth/access_token",
      scopes: ["ads_management", "ads_read", "business_management"],
    } as ConnectorOAuthConfig,
  },
  stripe: {
    label: "Stripe",
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
    environmentMapping: {
      STRIPE_API_KEY: "$secrets.STRIPE_ACCESS_TOKEN",
    } as Record<string, string>,
    oauth: {
      authorizationUrl: "https://connect.stripe.com/oauth/authorize",
      tokenUrl: "https://connect.stripe.com/oauth/token",
      scopes: ["read_write"],
    } as ConnectorOAuthConfig,
  },
} as const;

export type ConnectorType = keyof typeof CONNECTOR_TYPES;

/**
 * Proxy-side connector configuration for token replacement.
 *
 * Defines which URL targets each connector covers and how auth headers
 * are constructed. Used by the proxy to intercept requests matching a
 * connector's targets and replace placeholder tokens with real credentials.
 *
 * `${token}` in header values is replaced with the real OAuth access token.
 *
 * NOTE: Currently hardcoded in CONNECTOR_PROXY_CONFIGS below.
 * Will be migrated to GitHub-hosted connector.yaml definitions in Phase 2.
 */
export interface ConnectorProxyConfig {
  targets: string[];
  auth: {
    headers: Record<string, string>;
  };
}

const BEARER_AUTH = { headers: { Authorization: "Bearer ${token}" } };

const CONNECTOR_PROXY_CONFIGS: Partial<
  Record<ConnectorType, ConnectorProxyConfig>
> = {
  airtable: {
    targets: ["https://api.airtable.com"],
    auth: BEARER_AUTH,
  },
  github: {
    targets: ["https://api.github.com"],
    auth: BEARER_AUTH,
  },
  notion: {
    targets: ["https://api.notion.com/v1"],
    auth: {
      headers: {
        Authorization: "Bearer ${token}",
        "Notion-Version": "2022-06-28",
      },
    },
  },
  gmail: {
    targets: ["https://gmail.googleapis.com/gmail/v1/users/me"],
    auth: BEARER_AUTH,
  },
  "google-sheets": {
    targets: ["https://sheets.googleapis.com/v4/spreadsheets"],
    auth: BEARER_AUTH,
  },
  "google-docs": {
    targets: ["https://docs.googleapis.com/v1/documents"],
    auth: BEARER_AUTH,
  },
  "google-drive": {
    targets: ["https://www.googleapis.com/drive/v3"],
    auth: BEARER_AUTH,
  },
  "google-calendar": {
    targets: ["https://www.googleapis.com/calendar/v3"],
    auth: BEARER_AUTH,
  },
  hubspot: {
    targets: ["https://api.hubapi.com"],
    auth: BEARER_AUTH,
  },
  slack: {
    targets: ["https://slack.com/api", "https://files.slack.com"],
    auth: BEARER_AUTH,
  },
  docusign: {
    targets: [
      "https://demo.docusign.net/restapi",
      "https://na1.docusign.net/restapi",
    ],
    auth: BEARER_AUTH,
  },
  dropbox: {
    targets: [
      "https://api.dropboxapi.com/2",
      "https://content.dropboxapi.com/2",
    ],
    auth: BEARER_AUTH,
  },
  linear: {
    targets: ["https://api.linear.app"],
    auth: BEARER_AUTH,
  },
  deel: {
    targets: ["https://api.deel.com"],
    auth: BEARER_AUTH,
  },
  figma: {
    targets: ["https://api.figma.com"],
    auth: BEARER_AUTH,
  },
  mercury: {
    targets: ["https://api.mercury.com"],
    auth: BEARER_AUTH,
  },
  reddit: {
    targets: ["https://oauth.reddit.com"],
    auth: BEARER_AUTH,
  },
  strava: {
    targets: ["https://www.strava.com/api/v3"],
    auth: BEARER_AUTH,
  },
  x: {
    targets: ["https://api.x.com/2"],
    auth: BEARER_AUTH,
  },
  neon: {
    targets: ["https://console.neon.tech/api/v2"],
    auth: BEARER_AUTH,
  },
  vercel: {
    targets: ["https://api.vercel.com"],
    auth: BEARER_AUTH,
  },
  sentry: {
    targets: ["https://sentry.io/api"],
    auth: BEARER_AUTH,
  },
  monday: {
    targets: ["https://api.monday.com/v2"],
    auth: BEARER_AUTH,
  },
  canva: {
    targets: ["https://api.canva.com/rest/v1"],
    auth: BEARER_AUTH,
  },
  xero: {
    targets: ["https://api.xero.com"],
    auth: BEARER_AUTH,
  },
  supabase: {
    targets: ["https://api.supabase.com/v1"],
    auth: BEARER_AUTH,
  },
  todoist: {
    targets: ["https://api.todoist.com/rest/v2"],
    auth: BEARER_AUTH,
  },
  webflow: {
    targets: ["https://api.webflow.com/v2"],
    auth: BEARER_AUTH,
  },
  "meta-ads": {
    targets: ["https://graph.facebook.com"],
    auth: BEARER_AUTH,
  },
  stripe: {
    targets: ["https://api.stripe.com"],
    auth: BEARER_AUTH,
  },
};

export const connectorTypeSchema = z.enum([
  "airtable",
  "canva",
  "github",
  "gmail",
  "google-sheets",
  "hubspot",
  "google-docs",
  "google-drive",
  "google-calendar",
  "notion",
  "computer",
  "slack",
  "deel",
  "docusign",
  "dropbox",
  "linear",
  "figma",
  "mercury",
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
  "meta-ads",
  "stripe",
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
export function getConnectorDefaultAuthMethod(type: ConnectorType): string {
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
 * Get environment mapping for a connector type
 */
export function getConnectorEnvironmentMapping(
  type: ConnectorType,
): Record<string, string> {
  return CONNECTOR_TYPES[type].environmentMapping;
}

/**
 * Get proxy config for a connector type (targets + auth headers).
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
    const mapping = config.environmentMapping as Record<string, string>;
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
 * Connector response schema
 */
export const connectorResponseSchema = z.object({
  id: z.string().uuid(),
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
