/**
 * Generate Nintendo Switch Parental Controls firewall config.
 *
 * Data source: Nintendo Switch Parental Controls app 2.4.0 (build 660).
 */

import { Buffer } from "node:buffer";

import { NINTENDO_SWITCH_PARENTAL_CONTROLS_APP } from "@vm0/connectors/connectors/nintendo-switch-parental-controls";
import {
  logStats,
  renderCategories,
  renderDefaultAllowed,
  renderDefaultUnknownPolicy,
  renderPermissions,
  writeOutput,
  type PermissionGroup,
} from "./codegen";

const SMART_DEVICE_ID_PLACEHOLDER = "c0ffee5a-fe10-4ca1-8c0f-fee5afe10ca1";
const NINTENDO_JWT_KEY_ID_PLACEHOLDER = "5afe10ca-1c0f-4fee-8afe-10ca1c0ffee5";
const NINTENDO_ID_TOKEN_JTI_PLACEHOLDER =
  "10ca1c0f-fee5-4afe-8c0f-fee5afe10ca1";
const NINTENDO_ACCESS_TOKEN_JTI_PLACEHOLDER =
  "afe10ca1-c0ff-4ee5-8afe-10ca1c0ffee5";
const NINTENDO_JWT_ISSUED_AT = 4_102_443_900;
const NINTENDO_JWT_EXPIRES_AT = NINTENDO_JWT_ISSUED_AT + 900;
// Nintendo Account ID and access tokens use RS256 with 2048-bit keys from
// https://accounts.nintendo.com/1.0.0/certificates.
const NINTENDO_JWT_SIGNATURE = "CoffeeSafeLocal".repeat(23).slice(0, 342);

function nintendoJwtPlaceholder(
  payload: Readonly<Record<string, unknown>>,
): string {
  const encode = (value: unknown): string => {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
  };
  return [
    encode({
      alg: "RS256",
      kid: NINTENDO_JWT_KEY_ID_PLACEHOLDER,
      jku: "https://accounts.nintendo.com/1.0.0/certificates",
    }),
    encode(payload),
    NINTENDO_JWT_SIGNATURE,
  ].join(".");
}

const ID_TOKEN_PLACEHOLDER = nintendoJwtPlaceholder({
  country: "US",
  jti: NINTENDO_ID_TOKEN_JTI_PLACEHOLDER,
  exp: NINTENDO_JWT_EXPIRES_AT,
  at_hash: "CoffeeSafeLocalCoffeeS",
  typ: "id_token",
  iat: NINTENDO_JWT_ISSUED_AT,
  iss: "https://accounts.nintendo.com",
  sub: "c0ffee5afe10ca1",
  aud: NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.clientId,
});
const ACCOUNT_TOKEN_PLACEHOLDER = nintendoJwtPlaceholder({
  aud: NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.clientId,
  typ: "token",
  sub: "c0ffee5afe10ca1",
  iat: NINTENDO_JWT_ISSUED_AT,
  iss: "https://accounts.nintendo.com",
  "ac:grt": 0,
  exp: NINTENDO_JWT_EXPIRES_AT,
  "ac:scp": [0, 8, 17, 320, 321, 325, 322, 323, 324, 326, 327, 328, 329],
  jti: NINTENDO_ACCESS_TOKEN_JTI_PLACEHOLDER,
});
const RUNTIME_ID_TOKEN_SECRET = "NINTENDO_SWITCH_PARENTAL_CONTROLS_TOKEN";
const RUNTIME_ACCOUNT_TOKEN_SECRET =
  "NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCOUNT_TOKEN";
const RUNTIME_SMART_DEVICE_ID_SECRET =
  "NINTENDO_SWITCH_PARENTAL_CONTROLS_SMART_DEVICE_ID";
const RUNTIME_LANGUAGE_VAR = "NINTENDO_SWITCH_PARENTAL_CONTROLS_LANGUAGE";

const ACCOUNT_READ: PermissionGroup = {
  name: "nintendo-switch-parental-controls-account-read",
  description: "Read the connected Nintendo Account and app user profile",
  rules: ["GET /2.0.0/users/me"],
};

const ACTION_PERMISSIONS: readonly PermissionGroup[] = [
  {
    name: ACCOUNT_READ.name,
    description: ACCOUNT_READ.description,
    rules: ["GET /v2/actions/user/fetchUser"],
  },
  {
    name: "nintendo-switch-parental-controls-announcements-read",
    description: "Read Nintendo Switch Parental Controls announcements",
    rules: ["GET /v2/actions/announcement/fetchAnnouncements"],
  },
  {
    name: "nintendo-switch-parental-controls-game-chat-read",
    description:
      "Read GameChat settings, requests, relationships, and terms for supervised players",
    rules: [
      "GET /v2/actions/chat/fetchCameraChatRequests",
      "GET /v2/actions/chat/fetchCameraSetting",
      "GET /v2/actions/chat/fetchChatRequests",
      "GET /v2/actions/chat/fetchChatSetting",
      "GET /v2/actions/chat/fetchTermOfUse",
    ],
  },
  {
    name: "nintendo-switch-parental-controls-play-summary-read",
    description:
      "Read daily and monthly play summaries for supervised Nintendo Switch devices",
    rules: [
      "GET /v2/actions/playSummary/fetchDailySummaries",
      "GET /v2/actions/playSummary/fetchLatestMonthlySummary",
      "GET /v2/actions/playSummary/fetchMonthlySummary",
    ],
  },
  {
    name: "nintendo-switch-parental-controls-device-credentials-read",
    description:
      "Read device and federation records that may contain serial numbers, synchronized PINs, or pairing state",
    rules: [
      "GET /v3/actions/device/fetchExtraPlayingTimeState",
      "GET /v3/actions/deviceFederation/checkDeviceFederation",
      "GET /v3/actions/user/fetchOwnedDevice",
      "GET /v3/actions/user/fetchOwnedDevices",
    ],
  },
  {
    name: "nintendo-switch-parental-controls-settings-credentials-read",
    description:
      "Read parental-control settings that may contain the current unlock PIN",
    rules: [
      "GET /v3/actions/parentalControlSetting/fetchParentalControlSetting",
    ],
  },
  {
    name: "nintendo-switch-parental-controls-game-chat-write",
    description:
      "Accept, reject, suspend, or change GameChat relationships and settings for supervised players",
    rules: [
      "POST /v2/actions/chat/acceptCameraChatRequest",
      "POST /v2/actions/chat/acceptChatRequest",
      "POST /v2/actions/chat/agreeChildTerm",
      "POST /v2/actions/chat/checkRelationship",
      "POST /v2/actions/chat/rejectCameraChatRequest",
      "POST /v2/actions/chat/rejectChatRequest",
      "POST /v2/actions/chat/requestRelationshipCorrection",
      "POST /v2/actions/chat/suspendCameraChat",
      "POST /v2/actions/chat/updateCameraChatSetting",
      "POST /v2/actions/chat/updateCameraSetting",
      "POST /v2/actions/chat/updateMemo",
      "POST /v2/actions/chat/withdrawChatRequest",
    ],
  },
  {
    name: "nintendo-switch-parental-controls-play-time-write",
    description:
      "Confirm or change extra play time and play-timer restrictions for a supervised device",
    rules: [
      "POST /v2/actions/device/confirmExtraPlayingTime",
      "POST /v2/actions/device/updateExtraPlayingTime",
      "POST /v3/actions/parentalControlSetting/updatePlayTimer",
    ],
  },
  {
    name: "nintendo-switch-parental-controls-device-pairing-write",
    description:
      "Start or confirm device federation, which can create or change a supervised-device pairing",
    rules: [
      "POST /v2/actions/deviceFederation/startDeviceFederation",
      "POST /v2/actions/user/confirmCopiedOwnedDevice",
      "POST /v3/actions/federation",
    ],
  },
  {
    name: "nintendo-switch-parental-controls-feedback-write",
    description: "Send feedback to Nintendo from the connected account",
    rules: ["POST /v2/actions/feedback/sendFeedback"],
  },
  {
    name: "nintendo-switch-parental-controls-smart-device-write",
    description:
      "Change the registered smart device, including notification-token updates or logout",
    rules: [
      "POST /v2/actions/logout",
      "POST /v2/actions/smartDevice/updateNotificationToken",
    ],
  },
  {
    name: "nintendo-switch-parental-controls-settings-write",
    description: "Change parental-control restriction levels or the unlock PIN",
    rules: [
      "POST /v2/actions/parentalControlSetting/updateRestrictionLevel",
      "POST /v2/actions/parentalControlSetting/updateUnlockCode",
    ],
  },
  {
    name: "nintendo-switch-parental-controls-device-write",
    description:
      "Rename, reorder, or unregister a supervised Nintendo Switch device",
    rules: [
      "POST /v3/actions/device/unregisterDevice",
      "POST /v3/actions/device/updateDeviceLabel",
      "POST /v3/actions/user/updateOwnedDeviceSortOrder",
    ],
  },
  {
    name: "nintendo-switch-parental-controls-notifications-write",
    description:
      "Clear notices or change notification settings for the connected account",
    rules: [
      "POST /v2/actions/user/clearAlarmSettingNotice",
      "POST /v2/actions/user/updateNotificationSetting",
    ],
  },
  {
    name: "nintendo-switch-parental-controls-summary-acknowledgement-write",
    description:
      "Acknowledge first daily or newly available monthly play summaries",
    rules: [
      "POST /v3/actions/user/confirmFirstDailySummary",
      "POST /v3/actions/user/confirmNewMonthlySummary",
    ],
  },
];

const DEFAULT_ALLOWED = [
  ACCOUNT_READ.name,
  "nintendo-switch-parental-controls-announcements-read",
  "nintendo-switch-parental-controls-game-chat-read",
  "nintendo-switch-parental-controls-play-summary-read",
];

const CATEGORIES = {
  categories: {
    [ACCOUNT_READ.name]: "Read",
    "nintendo-switch-parental-controls-announcements-read": "Read",
    "nintendo-switch-parental-controls-game-chat-read": "Read",
    "nintendo-switch-parental-controls-play-summary-read": "Read",
    "nintendo-switch-parental-controls-device-credentials-read":
      "Sensitive read",
    "nintendo-switch-parental-controls-settings-credentials-read":
      "Sensitive read",
    "nintendo-switch-parental-controls-game-chat-write": "Write",
    "nintendo-switch-parental-controls-play-time-write": "Write",
    "nintendo-switch-parental-controls-device-pairing-write": "Write",
    "nintendo-switch-parental-controls-feedback-write": "Write",
    "nintendo-switch-parental-controls-smart-device-write": "Write",
    "nintendo-switch-parental-controls-settings-write": "Write",
    "nintendo-switch-parental-controls-device-write": "Write",
    "nintendo-switch-parental-controls-notifications-write": "Write",
    "nintendo-switch-parental-controls-summary-acknowledgement-write": "Write",
  },
  displayOrder: ["Read", "Sensitive read", "Write"],
};

function generateTypeScript(): string {
  const app = NINTENDO_SWITCH_PARENTAL_CONTROLS_APP;
  const lines = [
    "// Auto-generated from Nintendo Switch Parental Controls app 2.4.0 (build 660).",
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:nintendo-switch-parental-controls",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig, FirewallPolicyValue, PermissionNamesOf } from "../firewall-types";',
    "",
    "export const nintendoSwitchParentalControlsFirewall = {",
    '  name: "nintendo-switch-parental-controls",',
    '  description: "Nintendo Switch Parental Controls API",',
    "  placeholders: {",
    `    ${RUNTIME_ID_TOKEN_SECRET}: "${ID_TOKEN_PLACEHOLDER}",`,
    `    ${RUNTIME_ACCOUNT_TOKEN_SECRET}: "${ACCOUNT_TOKEN_PLACEHOLDER}",`,
    `    ${RUNTIME_SMART_DEVICE_ID_SECRET}: "${SMART_DEVICE_ID_PLACEHOLDER}",`,
    "  },",
    "  apis: [",
    "    {",
    `      base: "${app.accountBaseUrl}",`,
    "      auth: {",
    "        headers: {",
    `          Authorization: "Bearer \${{ secrets.${RUNTIME_ACCOUNT_TOKEN_SECRET} }}",`,
    `          "User-Agent": "${app.userAgent}",`,
    "        },",
    "      },",
    "      permissions: [",
    ...renderPermissions([ACCOUNT_READ]),
    "      ],",
    "    },",
    "    {",
    `      base: "${app.actionBaseUrl}",`,
    "      auth: {",
    "        headers: {",
    `          Authorization: "Bearer \${{ secrets.${RUNTIME_ID_TOKEN_SECRET} }}",`,
    `          "User-Agent": "${app.userAgent}",`,
    `          "X-Moon-App-Id": "${app.packageId}",`,
    `          "X-Moon-Os": "${app.os}",`,
    `          "X-Moon-Os-Version": "${app.osVersion}",`,
    `          "X-Moon-Model": "${app.modelName}",`,
    `          "X-Moon-TimeZone": "${app.timeZone}",`,
    `          "X-Moon-Os-Language": "\${{ vars.${RUNTIME_LANGUAGE_VAR} }}",`,
    `          "X-Moon-App-Language": "\${{ vars.${RUNTIME_LANGUAGE_VAR} }}",`,
    `          "X-Moon-App-Display-Version": "${app.displayedVersion}",`,
    `          "X-Moon-App-Internal-Version": "${app.internalVersion}",`,
    `          "X-Moon-Smart-Device-Id": "\${{ secrets.${RUNTIME_SMART_DEVICE_ID_SECRET} }}",`,
    "        },",
    "      },",
    "      permissions: [",
    ...renderPermissions([...ACTION_PERMISSIONS]),
    "      ],",
    "    },",
    "  ],",
    "} as const satisfies FirewallConfig;",
    ...renderDefaultAllowed(
      "nintendoSwitchParentalControlsDefaultAllowed",
      "nintendoSwitchParentalControlsFirewall",
      DEFAULT_ALLOWED,
    ),
    ...renderCategories(
      "nintendoSwitchParentalControlsCategories",
      "nintendoSwitchParentalControlsFirewall",
      CATEGORIES,
    ),
    ...renderDefaultUnknownPolicy(
      "nintendoSwitchParentalControlsDefaultUnknownPolicy",
      "deny",
    ),
  ];
  return lines.join("\n");
}

export async function generate(): Promise<void> {
  console.error(
    "Generating Nintendo Switch Parental Controls firewall config...",
  );
  writeOutput("nintendo-switch-parental-controls", generateTypeScript());
  logStats([ACCOUNT_READ, ...ACTION_PERMISSIONS]);
}
