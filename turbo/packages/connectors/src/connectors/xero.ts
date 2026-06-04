import type { ConnectorConfig } from "../connectors";

export const xero = {
  xero: {
    label: "Xero",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Xero account to access accounting data, invoices, and contacts",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Xero to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "XERO_OAUTH_CLIENT_ID",
          clientSecretEnv: "XERO_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["XERO_ACCESS_TOKEN", "XERO_REFRESH_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "auth-code",
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
          outputs: {
            accessToken: "$secrets.XERO_ACCESS_TOKEN",
            refreshToken: "$secrets.XERO_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.XERO_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.XERO_ACCESS_TOKEN",
            refreshToken: "$secrets.XERO_REFRESH_TOKEN",
          },
          refreshableSecrets: ["XERO_ACCESS_TOKEN"],
          envBindings: {
            XERO_TOKEN: "$secrets.XERO_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
