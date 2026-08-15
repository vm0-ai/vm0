import type { ConnectorAuthMethodRuntimeConfig } from "../../../connector-config";
import { NINTENDO_SWITCH_PARENTAL_CONTROLS_APP } from "../nintendo-switch-parental-controls/app";

// These selected-method fixtures are test-only and must never become a
// production fallback for connector catalog data.
export const AWS_PROVIDER_METHOD = {
  client: {
    clientRegistration: "static",
    clientType: "public",
    clientId: "arn:aws:signin:::devtools/cross-device",
  },
  storage: {
    version: 1,
    secrets: [
      "AWS_LOGIN_REFRESH_TOKEN",
      "AWS_LOGIN_DPOP_KEY",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
    ],
    variables: ["AWS_SIGNIN_REGION", "AWS_REGION"],
  },
  grant: {
    kind: "external-code",
    scopes: ["openid"],
    outputs: {
      refreshToken: "$secrets.AWS_LOGIN_REFRESH_TOKEN",
      dpopKey: "$secrets.AWS_LOGIN_DPOP_KEY",
      accessKeyId: "$secrets.AWS_ACCESS_KEY_ID",
      secretAccessKey: "$secrets.AWS_SECRET_ACCESS_KEY",
      sessionToken: "$secrets.AWS_SESSION_TOKEN",
      signinRegion: "$vars.AWS_SIGNIN_REGION",
      runtimeRegion: "$vars.AWS_REGION",
    },
  },
  access: {
    kind: "refresh-token",
    inputs: {
      refreshToken: "$secrets.AWS_LOGIN_REFRESH_TOKEN",
      dpopKey: "$secrets.AWS_LOGIN_DPOP_KEY",
      signinRegion: "$vars.AWS_SIGNIN_REGION",
    },
    outputs: {
      refreshToken: "$secrets.AWS_LOGIN_REFRESH_TOKEN",
      accessKeyId: "$secrets.AWS_ACCESS_KEY_ID",
      secretAccessKey: "$secrets.AWS_SECRET_ACCESS_KEY",
      sessionToken: "$secrets.AWS_SESSION_TOKEN",
    },
    refreshableSecrets: [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
    ],
    envBindings: {
      AWS_ACCESS_KEY_ID: "$secrets.AWS_ACCESS_KEY_ID",
      AWS_SECRET_ACCESS_KEY: "$secrets.AWS_SECRET_ACCESS_KEY",
      AWS_SESSION_TOKEN: "$secrets.AWS_SESSION_TOKEN",
      AWS_REGION: "$vars.AWS_REGION",
      AWS_DEFAULT_REGION: "$vars.AWS_REGION",
    },
  },
  revoke: { kind: "none" },
} as const satisfies ConnectorAuthMethodRuntimeConfig;

export const NINTENDO_STORE_PROVIDER_METHOD = {
  client: {
    clientRegistration: "static",
    clientType: "public",
    clientId: "5c38e31cd085304b",
  },
  storage: {
    version: 1,
    secrets: [
      "NINTENDO_STORE_SESSION_TOKEN",
      "NINTENDO_STORE_ACCESS_TOKEN",
      "NINTENDO_STORE_ID_TOKEN",
    ],
    variables: ["NINTENDO_STORE_ACCOUNT_ID", "NINTENDO_STORE_LOCALE"],
  },
  grant: {
    kind: "external-code",
    scopes: ["openid", "user", "user.mii", "user.email", "user.links[].id"],
    outputs: {
      sessionToken: "$secrets.NINTENDO_STORE_SESSION_TOKEN",
      accessToken: "$secrets.NINTENDO_STORE_ACCESS_TOKEN",
      idToken: "$secrets.NINTENDO_STORE_ID_TOKEN",
      accountId: "$vars.NINTENDO_STORE_ACCOUNT_ID",
      locale: "$vars.NINTENDO_STORE_LOCALE",
    },
  },
  access: {
    kind: "refresh-token",
    inputs: {
      sessionToken: "$secrets.NINTENDO_STORE_SESSION_TOKEN",
    },
    outputs: {
      accessToken: "$secrets.NINTENDO_STORE_ACCESS_TOKEN",
      idToken: "$secrets.NINTENDO_STORE_ID_TOKEN",
      locale: "$vars.NINTENDO_STORE_LOCALE",
    },
    refreshableSecrets: ["NINTENDO_STORE_ACCESS_TOKEN"],
    envBindings: {
      NINTENDO_STORE_TOKEN: "$secrets.NINTENDO_STORE_ACCESS_TOKEN",
      NINTENDO_STORE_LOCALE: "$vars.NINTENDO_STORE_LOCALE",
    },
  },
  revoke: { kind: "none" },
} as const satisfies ConnectorAuthMethodRuntimeConfig;

export const NINTENDO_SWITCH_PARENTAL_CONTROLS_PROVIDER_METHOD = {
  client: {
    clientRegistration: "static",
    clientType: "public",
    clientId: NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.clientId,
  },
  storage: {
    version: 1,
    secrets: [
      "NINTENDO_SWITCH_PARENTAL_CONTROLS_SESSION_TOKEN",
      "NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCESS_TOKEN",
      "NINTENDO_SWITCH_PARENTAL_CONTROLS_ID_TOKEN",
      "NINTENDO_SWITCH_PARENTAL_CONTROLS_SMART_DEVICE_ID",
    ],
    variables: [
      "NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCOUNT_ID",
      "NINTENDO_SWITCH_PARENTAL_CONTROLS_LANGUAGE",
      "NINTENDO_SWITCH_PARENTAL_CONTROLS_DEVICE_CATALOG",
    ],
  },
  grant: {
    kind: "external-code",
    scopes: NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.scopes.slice(),
    outputs: {
      sessionToken: "$secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_SESSION_TOKEN",
      accessToken: "$secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCESS_TOKEN",
      idToken: "$secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_ID_TOKEN",
      smartDeviceId:
        "$secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_SMART_DEVICE_ID",
      accountId: "$vars.NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCOUNT_ID",
      language: "$vars.NINTENDO_SWITCH_PARENTAL_CONTROLS_LANGUAGE",
      deviceCatalog: "$vars.NINTENDO_SWITCH_PARENTAL_CONTROLS_DEVICE_CATALOG",
    },
  },
  access: {
    kind: "refresh-token",
    inputs: {
      sessionToken: "$secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_SESSION_TOKEN",
      smartDeviceId:
        "$secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_SMART_DEVICE_ID",
      language: "$vars.NINTENDO_SWITCH_PARENTAL_CONTROLS_LANGUAGE",
    },
    outputs: {
      accessToken: "$secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCESS_TOKEN",
      idToken: "$secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_ID_TOKEN",
      deviceCatalog: "$vars.NINTENDO_SWITCH_PARENTAL_CONTROLS_DEVICE_CATALOG",
    },
    refreshableSecrets: [
      "NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCESS_TOKEN",
      "NINTENDO_SWITCH_PARENTAL_CONTROLS_ID_TOKEN",
    ],
    envBindings: {
      NINTENDO_SWITCH_PARENTAL_CONTROLS_TOKEN:
        "$secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_ID_TOKEN",
      NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCOUNT_TOKEN:
        "$secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCESS_TOKEN",
      NINTENDO_SWITCH_PARENTAL_CONTROLS_SMART_DEVICE_ID:
        "$secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_SMART_DEVICE_ID",
      NINTENDO_SWITCH_PARENTAL_CONTROLS_LANGUAGE:
        "$vars.NINTENDO_SWITCH_PARENTAL_CONTROLS_LANGUAGE",
      NINTENDO_SWITCH_PARENTAL_CONTROLS_DEVICE_CATALOG:
        "$vars.NINTENDO_SWITCH_PARENTAL_CONTROLS_DEVICE_CATALOG",
    },
  },
  revoke: {
    kind: "token-revoke",
    revokePreviousOnReplace: true,
    inputs: {
      sessionToken: "$secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_SESSION_TOKEN",
      smartDeviceId:
        "$secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_SMART_DEVICE_ID",
    },
  },
} as const satisfies ConnectorAuthMethodRuntimeConfig;

export const PLAYSTATION_PROVIDER_METHOD = {
  client: {
    clientRegistration: "static",
    clientType: "public",
    clientId: "09515159-7237-4370-9b40-3806e67c0891",
  },
  storage: {
    version: 1,
    secrets: [
      "PLAYSTATION_ACCESS_TOKEN",
      "PLAYSTATION_REFRESH_TOKEN",
      "PLAYSTATION_ID_TOKEN",
    ],
    variables: ["PLAYSTATION_ACCOUNT_ID", "PLAYSTATION_ONLINE_ID"],
  },
  grant: {
    kind: "external-code",
    scopes: ["psn:mobile.v2.core", "psn:clientapp"],
    outputs: {
      accessToken: "$secrets.PLAYSTATION_ACCESS_TOKEN",
      refreshToken: "$secrets.PLAYSTATION_REFRESH_TOKEN",
      idToken: "$secrets.PLAYSTATION_ID_TOKEN",
      accountId: "$vars.PLAYSTATION_ACCOUNT_ID",
      onlineId: "$vars.PLAYSTATION_ONLINE_ID",
    },
  },
  access: {
    kind: "refresh-token",
    inputs: {
      refreshToken: "$secrets.PLAYSTATION_REFRESH_TOKEN",
    },
    outputs: {
      accessToken: "$secrets.PLAYSTATION_ACCESS_TOKEN",
      refreshToken: "$secrets.PLAYSTATION_REFRESH_TOKEN",
      idToken: "$secrets.PLAYSTATION_ID_TOKEN",
    },
    refreshableSecrets: ["PLAYSTATION_ACCESS_TOKEN"],
    envBindings: {
      PLAYSTATION_TOKEN: "$secrets.PLAYSTATION_ACCESS_TOKEN",
      PLAYSTATION_ACCOUNT_ID: {
        valueRef: "$vars.PLAYSTATION_ACCOUNT_ID",
        optional: true,
      },
      PLAYSTATION_ONLINE_ID: {
        valueRef: "$vars.PLAYSTATION_ONLINE_ID",
        optional: true,
      },
    },
  },
  revoke: { kind: "none" },
} as const satisfies ConnectorAuthMethodRuntimeConfig;
