import type { ConnectorConfig } from "../connector-config";

export const NINTENDO_SWITCH_PARENTAL_CONTROLS_APP = {
  clientId: "54789befb391a838",
  redirectUri: "npf54789befb391a838://auth",
  packageId: "com.nintendo.znma",
  displayedVersion: "2.4.0",
  internalVersion: 660,
  os: "ANDROID",
  osVersion: "35",
  modelName: "vm0",
  timeZone: "Etc/UTC",
  actionBaseUrl: "https://app.lp1.znma.srv.nintendo.net",
  accountBaseUrl: "https://api.accounts.nintendo.com",
  scopes: [
    "openid",
    "user",
    "user.mii",
    "moonUser:administration",
    "moonDevice:create",
    "moonOwnedDevice:administration",
    "moonParentalControlSetting",
    "moonParentalControlSetting:update",
    "moonParentalControlSettingState",
    "moonPairingState",
    "moonSmartDevice:administration",
    "moonDailySummary",
    "moonMonthlySummary",
  ],
  userAgent: "moon_ANDROID/2.4.0 (com.nintendo.znma; build:660; ANDROID 35)",
} as const;

export const nintendoSwitchParentalControls = {
  "nintendo-switch-parental-controls": {
    label: "Nintendo Switch Parental Controls",
    category: "data-automation-infrastructure",
    tags: [
      "gaming",
      "player",
      "nintendo",
      "parental-controls",
      "playtime",
      "gamechat",
    ],
    helpText:
      "Connect Nintendo Switch Parental Controls to read household play activity and manage explicitly granted console settings.",
    authMethods: {
      api: {
        label: "Nintendo sign-in",
        helpText:
          "Sign in with the adult Nintendo Account used by the Nintendo Switch Parental Controls app. After signing in, right-click the redirect button and copy its link address, then paste the full `npf...://auth` redirect URL or the `session_token_code` value.",
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
            sessionToken:
              "$secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_SESSION_TOKEN",
            accessToken:
              "$secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCESS_TOKEN",
            idToken: "$secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_ID_TOKEN",
            smartDeviceId:
              "$secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_SMART_DEVICE_ID",
            accountId: "$vars.NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCOUNT_ID",
            language: "$vars.NINTENDO_SWITCH_PARENTAL_CONTROLS_LANGUAGE",
            deviceCatalog:
              "$vars.NINTENDO_SWITCH_PARENTAL_CONTROLS_DEVICE_CATALOG",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            sessionToken:
              "$secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_SESSION_TOKEN",
            smartDeviceId:
              "$secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_SMART_DEVICE_ID",
            language: "$vars.NINTENDO_SWITCH_PARENTAL_CONTROLS_LANGUAGE",
          },
          outputs: {
            accessToken:
              "$secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCESS_TOKEN",
            idToken: "$secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_ID_TOKEN",
            deviceCatalog:
              "$vars.NINTENDO_SWITCH_PARENTAL_CONTROLS_DEVICE_CATALOG",
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
            sessionToken:
              "$secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_SESSION_TOKEN",
            smartDeviceId:
              "$secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_SMART_DEVICE_ID",
          },
        },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
