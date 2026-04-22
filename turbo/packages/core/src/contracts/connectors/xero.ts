import type { ConnectorConfig } from "../connectors";

export const xero = {
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
} as const satisfies Record<string, ConnectorConfig>;
