import type { ConnectorAuthMethodRuntimeConfig } from "../connector-config";
import type {
  ConnectorAuthClientForConfig,
  ConnectorAuthClientIdentityForConfig,
} from "../connector-auth-method";

export type ConnectorAuthProviderClientContract =
  | { readonly kind: "none" }
  | {
      readonly kind: "static-confidential-env";
      readonly clientIdEnv: string;
      readonly clientSecretEnv: string;
    }
  | { readonly kind: "static-confidential-literal" }
  | {
      readonly kind: "static-public-env";
      readonly clientIdEnv: string;
    }
  | { readonly kind: "static-public-literal" }
  | { readonly kind: "dynamic-public" };

export interface ConnectorAuthProviderMethodContract {
  readonly client: ConnectorAuthProviderClientContract;
  readonly grant: {
    readonly kind: ConnectorAuthMethodRuntimeConfig["grant"]["kind"];
    readonly callbackOrigin: "web" | "api" | null;
    readonly outputNames: readonly string[];
    readonly startOptionNames: readonly string[];
  };
  readonly access: {
    readonly kind: ConnectorAuthMethodRuntimeConfig["access"]["kind"];
    readonly inputNames: readonly string[];
    readonly outputNames: readonly string[];
    readonly platformSecrets: readonly string[];
  };
  readonly revoke: {
    readonly kind: ConnectorAuthMethodRuntimeConfig["revoke"]["kind"];
    readonly inputNames: readonly string[];
  };
}

interface ConnectorAuthProviderMethodRegistration {
  readonly connectorRef: string;
  readonly authMethodId: string;
  readonly contract: ConnectorAuthProviderMethodContract;
}

// This is VM0's executable compatibility contract, not connector catalog data.
// Keep it limited to facts required to select and validate provider handlers.
export const CONNECTOR_AUTH_PROVIDER_METHOD_REGISTRATIONS = [
  {
    connectorRef: "ahrefs",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "AHREFS_OAUTH_CLIENT_ID",
        clientSecretEnv: "AHREFS_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "airtable",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "AIRTABLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "AIRTABLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "asana",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "ASANA_OAUTH_CLIENT_ID",
        clientSecretEnv: "ASANA_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "aws",
    authMethodId: "cli",
    contract: {
      client: {
        kind: "static-public-literal",
      },
      grant: {
        kind: "external-code",
        callbackOrigin: null,
        outputNames: [
          "accessKeyId",
          "dpopKey",
          "refreshToken",
          "runtimeRegion",
          "secretAccessKey",
          "sessionToken",
          "signinRegion",
        ],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["dpopKey", "refreshToken", "signinRegion"],
        outputNames: [
          "accessKeyId",
          "refreshToken",
          "secretAccessKey",
          "sessionToken",
        ],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "base44",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-public-literal",
      },
      grant: {
        kind: "device-auth",
        callbackOrigin: null,
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "box",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "BOX_OAUTH_CLIENT_ID",
        clientSecretEnv: "BOX_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "cal-com",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "CALCOM_OAUTH_CLIENT_ID",
        clientSecretEnv: "CALCOM_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "canva",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "CANVA_OAUTH_CLIENT_ID",
        clientSecretEnv: "CANVA_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "close",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "CLOSE_OAUTH_CLIENT_ID",
        clientSecretEnv: "CLOSE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "cloudflare",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "CLOUDFLARE_OAUTH_CLIENT_ID",
        clientSecretEnv: "CLOUDFLARE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "api",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "token-revoke",
        inputNames: ["refreshToken"],
      },
    },
  },
  {
    connectorRef: "copper",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "COPPER_OAUTH_CLIENT_ID",
        clientSecretEnv: "COPPER_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken"],
        startOptionNames: [],
      },
      access: {
        kind: "static",
        inputNames: [],
        outputNames: [],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "datadog",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "DATADOG_OAUTH_CLIENT_ID",
        clientSecretEnv: "DATADOG_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "domain", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["domain", "refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "deel",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "DEEL_OAUTH_CLIENT_ID",
        clientSecretEnv: "DEEL_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "docusign",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "DOCUSIGN_OAUTH_CLIENT_ID",
        clientSecretEnv: "DOCUSIGN_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "dropbox",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "DROPBOX_OAUTH_CLIENT_ID",
        clientSecretEnv: "DROPBOX_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "figma",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "FIGMA_OAUTH_CLIENT_ID",
        clientSecretEnv: "FIGMA_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "garmin-connect",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GARMIN_CONNECT_OAUTH_CLIENT_ID",
        clientSecretEnv: "GARMIN_CONNECT_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "github",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GH_OAUTH_CLIENT_ID",
        clientSecretEnv: "GH_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken"],
        startOptionNames: [],
      },
      access: {
        kind: "static",
        inputNames: [],
        outputNames: [],
        platformSecrets: [],
      },
      revoke: {
        kind: "token-revoke",
        inputNames: ["accessToken"],
      },
    },
  },
  {
    connectorRef: "gmail",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "google-ads",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: ["GOOGLE_ADS_DEVELOPER_TOKEN"],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "google-analytics",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "google-calendar",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "google-cloud",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "google-contacts",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "google-docs",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "google-drive",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "google-forms",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "google-maps",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "google-meet",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "google-search-console",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "google-sheets",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "gumroad",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GUMROAD_OAUTH_CLIENT_ID",
        clientSecretEnv: "GUMROAD_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "hubspot",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "HUBSPOT_OAUTH_CLIENT_ID",
        clientSecretEnv: "HUBSPOT_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "intervals-icu",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "INTERVALS_ICU_OAUTH_CLIENT_ID",
        clientSecretEnv: "INTERVALS_ICU_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken"],
        startOptionNames: [],
      },
      access: {
        kind: "static",
        inputNames: [],
        outputNames: [],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "lark",
    authMethodId: "api-token",
    contract: {
      client: {
        kind: "none",
      },
      grant: {
        kind: "manual",
        callbackOrigin: null,
        outputNames: [],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["appId", "appSecret"],
        outputNames: ["accessToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "linear",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "LINEAR_OAUTH_CLIENT_ID",
        clientSecretEnv: "LINEAR_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "token-revoke",
        inputNames: ["accessToken"],
      },
    },
  },
  {
    connectorRef: "mailchimp",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "MAILCHIMP_OAUTH_CLIENT_ID",
        clientSecretEnv: "MAILCHIMP_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken"],
        startOptionNames: [],
      },
      access: {
        kind: "static",
        inputNames: [],
        outputNames: [],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "mercury",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "MERCURY_OAUTH_CLIENT_ID",
        clientSecretEnv: "MERCURY_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "meta-ads",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "META_ADS_OAUTH_CLIENT_ID",
        clientSecretEnv: "META_ADS_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "microsoft-365",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "MICROSOFT_OAUTH_CLIENT_ID",
        clientSecretEnv: "MICROSOFT_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "monday",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "MONDAY_OAUTH_CLIENT_ID",
        clientSecretEnv: "MONDAY_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "neon",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "NEON_OAUTH_CLIENT_ID",
        clientSecretEnv: "NEON_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "netsuite",
    authMethodId: "api-token",
    contract: {
      client: {
        kind: "none",
      },
      grant: {
        kind: "manual",
        callbackOrigin: null,
        outputNames: [],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: [
          "accountSubdomain",
          "clientId",
          "clientSecret",
          "refreshToken",
        ],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "nintendo-store",
    authMethodId: "api",
    contract: {
      client: {
        kind: "static-public-literal",
      },
      grant: {
        kind: "external-code",
        callbackOrigin: null,
        outputNames: [
          "accessToken",
          "accountId",
          "idToken",
          "locale",
          "sessionToken",
        ],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["sessionToken"],
        outputNames: ["accessToken", "idToken", "locale"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "nintendo-switch-parental-controls",
    authMethodId: "api",
    contract: {
      client: {
        kind: "static-public-literal",
      },
      grant: {
        kind: "external-code",
        callbackOrigin: null,
        outputNames: [
          "accessToken",
          "accountId",
          "deviceCatalog",
          "idToken",
          "language",
          "sessionToken",
          "smartDeviceId",
        ],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["language", "sessionToken", "smartDeviceId"],
        outputNames: ["accessToken", "deviceCatalog", "idToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "token-revoke",
        inputNames: ["sessionToken", "smartDeviceId"],
      },
    },
  },
  {
    connectorRef: "notion",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "NOTION_OAUTH_CLIENT_ID",
        clientSecretEnv: "NOTION_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "outlook-calendar",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "MICROSOFT_OAUTH_CLIENT_ID",
        clientSecretEnv: "MICROSOFT_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "outlook-mail",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "MICROSOFT_OAUTH_CLIENT_ID",
        clientSecretEnv: "MICROSOFT_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "paypal",
    authMethodId: "api-token",
    contract: {
      client: {
        kind: "none",
      },
      grant: {
        kind: "manual",
        callbackOrigin: null,
        outputNames: [],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["clientId", "clientSecret"],
        outputNames: ["accessToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "playstation",
    authMethodId: "api",
    contract: {
      client: {
        kind: "static-public-literal",
      },
      grant: {
        kind: "external-code",
        callbackOrigin: null,
        outputNames: [
          "accessToken",
          "accountId",
          "idToken",
          "onlineId",
          "refreshToken",
        ],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "idToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "posthog",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "POSTHOG_OAUTH_CLIENT_ID",
        clientSecretEnv: "POSTHOG_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "quickbooks",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "QUICKBOOKS_OAUTH_CLIENT_ID",
        clientSecretEnv: "QUICKBOOKS_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "realmId", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "ramp",
    authMethodId: "api-token",
    contract: {
      client: {
        kind: "none",
      },
      grant: {
        kind: "manual",
        callbackOrigin: null,
        outputNames: [],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["clientId", "clientSecret", "scope"],
        outputNames: ["accessToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "reddit",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "REDDIT_OAUTH_CLIENT_ID",
        clientSecretEnv: "REDDIT_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "sentry",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "SENTRY_OAUTH_CLIENT_ID",
        clientSecretEnv: "SENTRY_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "slack",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "SLACK_OAUTH_CLIENT_ID",
        clientSecretEnv: "SLACK_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken"],
        startOptionNames: [],
      },
      access: {
        kind: "static",
        inputNames: [],
        outputNames: [],
        platformSecrets: [],
      },
      revoke: {
        kind: "token-revoke",
        inputNames: ["accessToken"],
      },
    },
  },
  {
    connectorRef: "slock",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "dynamic-public",
      },
      grant: {
        kind: "device-auth",
        callbackOrigin: null,
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "spotify",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "SPOTIFY_OAUTH_CLIENT_ID",
        clientSecretEnv: "SPOTIFY_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "steam",
    authMethodId: "openid",
    contract: {
      client: {
        kind: "none",
      },
      grant: {
        kind: "openid-auth",
        callbackOrigin: "api",
        outputNames: ["steamId"],
        startOptionNames: [],
      },
      access: {
        kind: "static",
        inputNames: [],
        outputNames: [],
        platformSecrets: ["STEAM_WEB_API_KEY"],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "strava",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "STRAVA_OAUTH_CLIENT_ID",
        clientSecretEnv: "STRAVA_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "stripe",
    authMethodId: "cli",
    contract: {
      client: {
        kind: "dynamic-public",
      },
      grant: {
        kind: "device-auth",
        callbackOrigin: null,
        outputNames: ["token"],
        startOptionNames: ["mode"],
      },
      access: {
        kind: "static",
        inputNames: [],
        outputNames: [],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "stripe",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "STRIPE_OAUTH_CLIENT_ID",
        clientSecretEnv: "STRIPE_SECRET_KEY",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "supabase",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "SUPABASE_OAUTH_CLIENT_ID",
        clientSecretEnv: "SUPABASE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "test-oauth",
    authMethodId: "api",
    contract: {
      client: {
        kind: "static-confidential-literal",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "api",
        outputNames: ["initialAccessToken", "initialRefreshToken", "tenantId"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["apiRefreshToken", "tenantId"],
        outputNames: [
          "refreshedAccessToken",
          "refreshedRefreshToken",
          "refreshedTenantId",
          "secondaryToken",
        ],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "test-oauth",
    authMethodId: "api-token",
    contract: {
      client: {
        kind: "none",
      },
      grant: {
        kind: "manual",
        callbackOrigin: null,
        outputNames: [],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["inputSecret", "inputVariable"],
        outputNames: ["accessToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "test-oauth",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-literal",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "api",
        outputNames: ["accessToken", "refreshToken", "tenantId"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "test-oauth-device",
    authMethodId: "api",
    contract: {
      client: {
        kind: "static-public-literal",
      },
      grant: {
        kind: "device-auth",
        callbackOrigin: null,
        outputNames: ["accessToken"],
        startOptionNames: ["mode"],
      },
      access: {
        kind: "static",
        inputNames: [],
        outputNames: [],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "test-oauth-device",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-public-literal",
      },
      grant: {
        kind: "device-auth",
        callbackOrigin: null,
        outputNames: ["accessToken"],
        startOptionNames: [],
      },
      access: {
        kind: "static",
        inputNames: [],
        outputNames: [],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "tiktok-ads",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "TIKTOK_ADS_OAUTH_CLIENT_ID",
        clientSecretEnv: "TIKTOK_ADS_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "todoist",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "TODOIST_OAUTH_CLIENT_ID",
        clientSecretEnv: "TODOIST_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken"],
        startOptionNames: [],
      },
      access: {
        kind: "static",
        inputNames: [],
        outputNames: [],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "vercel",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "VERCEL_OAUTH_CLIENT_ID",
        clientSecretEnv: "VERCEL_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken"],
        startOptionNames: [],
      },
      access: {
        kind: "static",
        inputNames: [],
        outputNames: [],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "webflow",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "WEBFLOW_OAUTH_CLIENT_ID",
        clientSecretEnv: "WEBFLOW_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken"],
        startOptionNames: [],
      },
      access: {
        kind: "static",
        inputNames: [],
        outputNames: [],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "workday",
    authMethodId: "api-token",
    contract: {
      client: {
        kind: "none",
      },
      grant: {
        kind: "manual",
        callbackOrigin: null,
        outputNames: [],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: [
          "clientId",
          "clientSecret",
          "host",
          "refreshToken",
          "tenant",
        ],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "x",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "X_OAUTH_CLIENT_ID",
        clientSecretEnv: "X_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "xero",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "XERO_OAUTH_CLIENT_ID",
        clientSecretEnv: "XERO_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
  {
    connectorRef: "youtube",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "token-revoke",
        inputNames: ["refreshToken"],
      },
    },
  },
  {
    connectorRef: "zoom",
    authMethodId: "oauth",
    contract: {
      client: {
        kind: "static-confidential-env",
        clientIdEnv: "ZOOM_OAUTH_CLIENT_ID",
        clientSecretEnv: "ZOOM_OAUTH_CLIENT_SECRET",
      },
      grant: {
        kind: "auth-code",
        callbackOrigin: "web",
        outputNames: ["accessToken", "refreshToken"],
        startOptionNames: [],
      },
      access: {
        kind: "refresh-token",
        inputNames: ["refreshToken"],
        outputNames: ["accessToken", "refreshToken"],
        platformSecrets: [],
      },
      revoke: {
        kind: "none",
        inputNames: [],
      },
    },
  },
] as const satisfies readonly ConnectorAuthProviderMethodRegistration[];

type ConnectorAuthProviderMethodRegistrationEntry =
  (typeof CONNECTOR_AUTH_PROVIDER_METHOD_REGISTRATIONS)[number];

export type ConnectorAuthProviderConnectorRef =
  ConnectorAuthProviderMethodRegistrationEntry["connectorRef"];

type ConnectorAuthProviderMethodRegistrationMap = {
  readonly [ConnectorRef in ConnectorAuthProviderConnectorRef]: {
    readonly [AuthMethodId in Extract<
      ConnectorAuthProviderMethodRegistrationEntry,
      { readonly connectorRef: ConnectorRef }
    >["authMethodId"]]: Extract<
      ConnectorAuthProviderMethodRegistrationEntry,
      {
        readonly connectorRef: ConnectorRef;
        readonly authMethodId: AuthMethodId;
      }
    >;
  };
};

export type ConnectorAuthProviderAuthMethodId<
  ConnectorRef extends ConnectorAuthProviderConnectorRef,
> = keyof ConnectorAuthProviderMethodRegistrationMap[ConnectorRef] & string;

export type ConnectorAuthProviderMethodRegistrationFor<
  ConnectorRef extends ConnectorAuthProviderConnectorRef,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorRef>,
> = ConnectorAuthProviderMethodRegistrationMap[ConnectorRef][AuthMethodId];

type ConnectorAuthProviderMethodRegistrationForConnector<
  ConnectorRef extends ConnectorAuthProviderConnectorRef,
> =
  ConnectorAuthProviderMethodRegistrationMap[ConnectorRef][ConnectorAuthProviderAuthMethodId<ConnectorRef>];

type RegistrationByGrantKind<
  Registration,
  Kind extends ConnectorAuthMethodRuntimeConfig["grant"]["kind"],
> = Registration extends {
  readonly contract: { readonly grant: { readonly kind: Kind } };
}
  ? Registration
  : never;

type RegistrationByAccessKind<
  Registration,
  Kind extends ConnectorAuthMethodRuntimeConfig["access"]["kind"],
> = Registration extends {
  readonly contract: { readonly access: { readonly kind: Kind } };
}
  ? Registration
  : never;

type RegistrationByRevokeKind<
  Registration,
  Kind extends ConnectorAuthMethodRuntimeConfig["revoke"]["kind"],
> = Registration extends {
  readonly contract: { readonly revoke: { readonly kind: Kind } };
}
  ? Registration
  : never;

export type ConnectorAuthProviderConnectorRefByGrantKind<
  Kind extends ConnectorAuthMethodRuntimeConfig["grant"]["kind"],
> = RegistrationByGrantKind<
  ConnectorAuthProviderMethodRegistrationEntry,
  Kind
>["connectorRef"];

export type ConnectorAuthProviderAuthMethodIdByGrantKind<
  ConnectorRef extends ConnectorAuthProviderConnectorRef,
  Kind extends ConnectorAuthMethodRuntimeConfig["grant"]["kind"],
> = ConnectorAuthProviderAuthMethodId<ConnectorRef> &
  RegistrationByGrantKind<
    ConnectorAuthProviderMethodRegistrationForConnector<ConnectorRef>,
    Kind
  >["authMethodId"];

export type ConnectorAuthProviderConnectorRefByAccessKind<
  Kind extends ConnectorAuthMethodRuntimeConfig["access"]["kind"],
> = RegistrationByAccessKind<
  ConnectorAuthProviderMethodRegistrationEntry,
  Kind
>["connectorRef"];

export type ConnectorAuthProviderAuthMethodIdByAccessKind<
  ConnectorRef extends ConnectorAuthProviderConnectorRef,
  Kind extends ConnectorAuthMethodRuntimeConfig["access"]["kind"],
> = ConnectorAuthProviderAuthMethodId<ConnectorRef> &
  RegistrationByAccessKind<
    ConnectorAuthProviderMethodRegistrationForConnector<ConnectorRef>,
    Kind
  >["authMethodId"];

export type ConnectorAuthProviderAuthMethodIdByRevokeKind<
  ConnectorRef extends ConnectorAuthProviderConnectorRef,
  Kind extends ConnectorAuthMethodRuntimeConfig["revoke"]["kind"],
> = ConnectorAuthProviderAuthMethodId<ConnectorRef> &
  RegistrationByRevokeKind<
    ConnectorAuthProviderMethodRegistrationForConnector<ConnectorRef>,
    Kind
  >["authMethodId"];

type ConnectorAuthProviderClientConfigForContract<
  Contract extends ConnectorAuthProviderClientContract,
> = Contract["kind"] extends "static-confidential-env"
  ? {
      readonly clientRegistration: "static";
      readonly clientType: "confidential";
      readonly clientIdEnv: string;
      readonly clientSecretEnv: string;
    }
  : Contract["kind"] extends "static-confidential-literal"
    ? {
        readonly clientRegistration: "static";
        readonly clientType: "confidential";
        readonly clientId: string;
        readonly clientSecret: string;
      }
    : Contract["kind"] extends "static-public-env"
      ? {
          readonly clientRegistration: "static";
          readonly clientType: "public";
          readonly clientIdEnv: string;
        }
      : Contract["kind"] extends "static-public-literal"
        ? {
            readonly clientRegistration: "static";
            readonly clientType: "public";
            readonly clientId: string;
          }
        : Contract["kind"] extends "dynamic-public"
          ? {
              readonly clientRegistration: "dynamic";
              readonly clientType: "public";
            }
          : never;

type ConnectorAuthProviderClientConfigFor<
  ConnectorRef extends ConnectorAuthProviderConnectorRef,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorRef>,
> = ConnectorAuthProviderClientConfigForContract<
  ConnectorAuthProviderMethodRegistrationFor<
    ConnectorRef,
    AuthMethodId
  >["contract"]["client"]
>;

export type ConnectorAuthProviderClientFor<
  ConnectorRef extends ConnectorAuthProviderConnectorRef,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorRef>,
> = ConnectorAuthClientForConfig<
  ConnectorAuthProviderClientConfigFor<ConnectorRef, AuthMethodId>
>;

export type ConnectorAuthProviderClientIdentityFor<
  ConnectorRef extends ConnectorAuthProviderConnectorRef,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorRef>,
> = ConnectorAuthClientIdentityForConfig<
  ConnectorAuthProviderClientConfigFor<ConnectorRef, AuthMethodId>
>;

export type ConnectorAuthProviderGrantOutputValuesFor<
  ConnectorRef extends ConnectorAuthProviderConnectorRef,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorRef>,
> = Readonly<
  Record<
    ConnectorAuthProviderMethodRegistrationFor<
      ConnectorRef,
      AuthMethodId
    >["contract"]["grant"]["outputNames"][number],
    string | null | undefined
  >
>;

export type ConnectorAuthProviderRefreshInputValuesFor<
  ConnectorRef extends ConnectorAuthProviderConnectorRef,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorRef>,
> = Readonly<
  Record<
    ConnectorAuthProviderMethodRegistrationFor<
      ConnectorRef,
      AuthMethodId
    >["contract"]["access"]["inputNames"][number],
    string
  >
>;

export type ConnectorAuthProviderRefreshOutputValuesFor<
  ConnectorRef extends ConnectorAuthProviderConnectorRef,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorRef>,
> = Readonly<
  Partial<
    Record<
      ConnectorAuthProviderMethodRegistrationFor<
        ConnectorRef,
        AuthMethodId
      >["contract"]["access"]["outputNames"][number],
      string | undefined
    >
  >
>;

export type ConnectorAuthProviderRevokeInputValuesFor<
  ConnectorRef extends ConnectorAuthProviderConnectorRef,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorRef>,
> = Readonly<
  Record<
    ConnectorAuthProviderMethodRegistrationFor<
      ConnectorRef,
      AuthMethodId
    >["contract"]["revoke"]["inputNames"][number],
    string
  >
>;
