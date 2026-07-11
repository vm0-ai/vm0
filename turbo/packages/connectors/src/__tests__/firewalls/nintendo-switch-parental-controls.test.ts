import { Buffer } from "node:buffer";

import { beforeAll, describe, expect, it } from "vitest";

import { NINTENDO_SWITCH_PARENTAL_CONTROLS_APP } from "../../connectors/nintendo-switch-parental-controls";
import {
  findMatchingPermissions,
  matchFirewallRequestDecision,
} from "../../firewall-rule-matcher";
import {
  extractSecretNamesFromApis,
  type FirewallConfig,
} from "../../firewall-types";
import {
  loadDefaultFirewallPolicies,
  loadRequiredConnectorFirewall,
} from "../firewall-test-helpers";

interface ExpectedRoute {
  readonly apiBase: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly permission: string;
}

const ACTION_BASE = NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.actionBaseUrl;
const ACCOUNT_BASE = NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.accountBaseUrl;

function actionRoutes(
  method: ExpectedRoute["method"],
  permission: string,
  paths: readonly string[],
): ExpectedRoute[] {
  return paths.map((path) => {
    return { apiBase: ACTION_BASE, method, path, permission };
  });
}

const EXPECTED_ROUTES: readonly ExpectedRoute[] = [
  {
    apiBase: ACCOUNT_BASE,
    method: "GET",
    path: "/2.0.0/users/me",
    permission: "nintendo-switch-parental-controls-account-read",
  },
  ...actionRoutes("GET", "nintendo-switch-parental-controls-account-read", [
    "/v2/actions/user/fetchUser",
  ]),
  ...actionRoutes(
    "GET",
    "nintendo-switch-parental-controls-announcements-read",
    ["/v2/actions/announcement/fetchAnnouncements"],
  ),
  ...actionRoutes("GET", "nintendo-switch-parental-controls-game-chat-read", [
    "/v2/actions/chat/fetchCameraChatRequests",
    "/v2/actions/chat/fetchCameraSetting",
    "/v2/actions/chat/fetchChatRequests",
    "/v2/actions/chat/fetchChatSetting",
    "/v2/actions/chat/fetchTermOfUse",
  ]),
  ...actionRoutes(
    "GET",
    "nintendo-switch-parental-controls-play-summary-read",
    [
      "/v2/actions/playSummary/fetchDailySummaries",
      "/v2/actions/playSummary/fetchLatestMonthlySummary",
      "/v2/actions/playSummary/fetchMonthlySummary",
    ],
  ),
  ...actionRoutes(
    "GET",
    "nintendo-switch-parental-controls-device-credentials-read",
    [
      "/v3/actions/device/fetchExtraPlayingTimeState",
      "/v3/actions/deviceFederation/checkDeviceFederation",
      "/v3/actions/user/fetchOwnedDevice",
      "/v3/actions/user/fetchOwnedDevices",
    ],
  ),
  ...actionRoutes(
    "GET",
    "nintendo-switch-parental-controls-settings-credentials-read",
    ["/v3/actions/parentalControlSetting/fetchParentalControlSetting"],
  ),
  ...actionRoutes("POST", "nintendo-switch-parental-controls-game-chat-write", [
    "/v2/actions/chat/acceptCameraChatRequest",
    "/v2/actions/chat/acceptChatRequest",
    "/v2/actions/chat/agreeChildTerm",
    "/v2/actions/chat/checkRelationship",
    "/v2/actions/chat/rejectCameraChatRequest",
    "/v2/actions/chat/rejectChatRequest",
    "/v2/actions/chat/requestRelationshipCorrection",
    "/v2/actions/chat/suspendCameraChat",
    "/v2/actions/chat/updateCameraChatSetting",
    "/v2/actions/chat/updateCameraSetting",
    "/v2/actions/chat/updateMemo",
    "/v2/actions/chat/withdrawChatRequest",
  ]),
  ...actionRoutes("POST", "nintendo-switch-parental-controls-play-time-write", [
    "/v2/actions/device/confirmExtraPlayingTime",
    "/v2/actions/device/updateExtraPlayingTime",
    "/v3/actions/parentalControlSetting/updatePlayTimer",
  ]),
  ...actionRoutes(
    "POST",
    "nintendo-switch-parental-controls-device-pairing-write",
    [
      "/v2/actions/deviceFederation/startDeviceFederation",
      "/v2/actions/user/confirmCopiedOwnedDevice",
      "/v3/actions/federation",
    ],
  ),
  ...actionRoutes("POST", "nintendo-switch-parental-controls-feedback-write", [
    "/v2/actions/feedback/sendFeedback",
  ]),
  ...actionRoutes(
    "POST",
    "nintendo-switch-parental-controls-smart-device-write",
    ["/v2/actions/logout", "/v2/actions/smartDevice/updateNotificationToken"],
  ),
  ...actionRoutes("POST", "nintendo-switch-parental-controls-settings-write", [
    "/v2/actions/parentalControlSetting/updateRestrictionLevel",
    "/v2/actions/parentalControlSetting/updateUnlockCode",
  ]),
  ...actionRoutes("POST", "nintendo-switch-parental-controls-device-write", [
    "/v3/actions/device/unregisterDevice",
    "/v3/actions/device/updateDeviceLabel",
    "/v3/actions/user/updateOwnedDeviceSortOrder",
  ]),
  ...actionRoutes(
    "POST",
    "nintendo-switch-parental-controls-notifications-write",
    [
      "/v2/actions/user/clearAlarmSettingNotice",
      "/v2/actions/user/updateNotificationSetting",
    ],
  ),
  ...actionRoutes(
    "POST",
    "nintendo-switch-parental-controls-summary-acknowledgement-write",
    [
      "/v3/actions/user/confirmFirstDailySummary",
      "/v3/actions/user/confirmNewMonthlySummary",
    ],
  ),
];

const DEFAULT_ALLOWED = new Set([
  "nintendo-switch-parental-controls-account-read",
  "nintendo-switch-parental-controls-announcements-read",
  "nintendo-switch-parental-controls-game-chat-read",
  "nintendo-switch-parental-controls-play-summary-read",
]);

let firewall: FirewallConfig;

function matcherNetworkPolicies(
  policy: Awaited<ReturnType<typeof loadDefaultFirewallPolicies>>,
) {
  const allow: string[] = [];
  const deny: string[] = [];
  for (const [permissionName, decision] of Object.entries(policy.policies)) {
    (decision === "allow" ? allow : deny).push(permissionName);
  }
  return {
    "nintendo-switch-parental-controls": {
      allow,
      deny,
      ask: [],
      unknownPolicy: policy.unknownPolicy,
    },
  };
}

function matchingPermissions(route: ExpectedRoute): string[] {
  return [
    ...findMatchingPermissions(route.method, route.path, firewall, {
      apiBase: route.apiBase,
    }),
  ].sort();
}

describe("Nintendo Switch Parental Controls firewall", () => {
  beforeAll(async () => {
    firewall = await loadRequiredConnectorFirewall(
      "nintendo-switch-parental-controls",
    );
  });

  it("injects the correct account and app credentials and app headers", () => {
    expect(firewall.name).toBe("nintendo-switch-parental-controls");
    expect(firewall.apis).toHaveLength(2);
    expect(
      Object.fromEntries(
        firewall.apis.map((api) => {
          return [api.base, api.auth];
        }),
      ),
    ).toStrictEqual({
      [ACCOUNT_BASE]: {
        headers: {
          Authorization:
            "Bearer ${{ secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCOUNT_TOKEN }}",
          "User-Agent": NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.userAgent,
        },
      },
      [ACTION_BASE]: {
        headers: {
          Authorization:
            "Bearer ${{ secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_TOKEN }}",
          "User-Agent": NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.userAgent,
          "X-Moon-App-Display-Version": "2.4.0",
          "X-Moon-App-Id": "com.nintendo.znma",
          "X-Moon-App-Internal-Version": "660",
          "X-Moon-App-Language":
            "${{ vars.NINTENDO_SWITCH_PARENTAL_CONTROLS_LANGUAGE }}",
          "X-Moon-Model": "vm0",
          "X-Moon-Os": "ANDROID",
          "X-Moon-Os-Language":
            "${{ vars.NINTENDO_SWITCH_PARENTAL_CONTROLS_LANGUAGE }}",
          "X-Moon-Os-Version": "35",
          "X-Moon-Smart-Device-Id":
            "${{ secrets.NINTENDO_SWITCH_PARENTAL_CONTROLS_SMART_DEVICE_ID }}",
          "X-Moon-TimeZone": "Etc/UTC",
        },
      },
    });
    expect(extractSecretNamesFromApis([...firewall.apis])).toStrictEqual([
      "NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCOUNT_TOKEN",
      "NINTENDO_SWITCH_PARENTAL_CONTROLS_TOKEN",
      "NINTENDO_SWITCH_PARENTAL_CONTROLS_SMART_DEVICE_ID",
    ]);
  });

  it("uses format-correct, non-obvious runtime placeholders", () => {
    const placeholders = firewall.placeholders;
    if (!placeholders) {
      throw new Error(
        "Expected Nintendo Switch Parental Controls placeholders",
      );
    }

    for (const value of Object.values(placeholders)) {
      expect(value).not.toMatch(/placeholder|fake|dummy|test|example/i);
    }
    for (const [name, expectedPayload] of [
      [
        "NINTENDO_SWITCH_PARENTAL_CONTROLS_TOKEN",
        {
          at_hash: "CoffeeSafeLocalCoffeeS",
          jti: "10ca1c0f-fee5-4afe-8c0f-fee5afe10ca1",
          typ: "id_token",
        },
      ],
      [
        "NINTENDO_SWITCH_PARENTAL_CONTROLS_ACCOUNT_TOKEN",
        {
          "ac:scp": [
            0, 8, 17, 320, 321, 325, 322, 323, 324, 326, 327, 328, 329,
          ],
          jti: "afe10ca1-c0ff-4ee5-8afe-10ca1c0ffee5",
          typ: "token",
        },
      ],
    ] as const) {
      const token = placeholders[name];
      const [encodedHeader, encodedPayload, signature, extra] =
        token?.split(".") ?? [];
      if (!encodedHeader || !encodedPayload || !signature || extra) {
        throw new Error(`Expected a three-segment Nintendo JWT for ${name}`);
      }
      const header: unknown = JSON.parse(
        Buffer.from(encodedHeader, "base64url").toString(),
      );
      const payload: unknown = JSON.parse(
        Buffer.from(encodedPayload, "base64url").toString(),
      );
      expect(header).toStrictEqual({
        alg: "RS256",
        kid: "5afe10ca-1c0f-4fee-8afe-10ca1c0ffee5",
        jku: "https://accounts.nintendo.com/1.0.0/certificates",
      });
      expect(payload).toMatchObject({
        aud: NINTENDO_SWITCH_PARENTAL_CONTROLS_APP.clientId,
        exp: 4_102_444_800,
        iat: 4_102_443_900,
        iss: "https://accounts.nintendo.com",
        ...expectedPayload,
      });
      expect(signature).toMatch(/^[A-Za-z0-9_-]{342}$/);
    }
    expect(
      placeholders["NINTENDO_SWITCH_PARENTAL_CONTROLS_SMART_DEVICE_ID"],
    ).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("covers the account profile and all 45 app action routes exactly", () => {
    expect(EXPECTED_ROUTES).toHaveLength(46);
    expect(
      EXPECTED_ROUTES.filter((route) => {
        return route.method === "GET";
      }),
    ).toHaveLength(16);
    expect(
      EXPECTED_ROUTES.filter((route) => {
        return route.method === "POST";
      }),
    ).toHaveLength(30);

    for (const route of EXPECTED_ROUTES) {
      expect(
        matchingPermissions(route),
        `${route.method} ${route.path}`,
      ).toEqual([route.permission]);
    }
  });

  it("matches representative action query strings through the request matcher", () => {
    for (const url of [
      `${ACTION_BASE}/v2/actions/announcement/fetchAnnouncements?appLanguage=en`,
      `${ACTION_BASE}/v2/actions/chat/fetchCameraSetting?deviceId=device-1&playerId=player-1`,
      `${ACTION_BASE}/v2/actions/playSummary/fetchMonthlySummary?deviceId=device-1&year=2026&month=7&containLatest=true`,
      `${ACTION_BASE}/v3/actions/user/fetchOwnedDevice?deviceId=device-1`,
    ]) {
      expect(
        matchFirewallRequestDecision([firewall], "GET", url),
      ).toMatchObject({
        kind: "allow",
        firewallName: "nintendo-switch-parental-controls",
      });
    }
  });

  it("allows ordinary reads and denies credential reads and writes by default", async () => {
    const policy = await loadDefaultFirewallPolicies(
      "nintendo-switch-parental-controls",
    );
    const networkPolicies = matcherNetworkPolicies(policy);
    const permissionNames = new Set(
      EXPECTED_ROUTES.map((route) => {
        return route.permission;
      }),
    );

    expect(permissionNames.size).toBe(15);
    expect(
      EXPECTED_ROUTES.filter((route) => {
        return DEFAULT_ALLOWED.has(route.permission);
      }),
    ).toHaveLength(11);
    expect(
      EXPECTED_ROUTES.filter((route) => {
        return route.method === "GET" && !DEFAULT_ALLOWED.has(route.permission);
      }),
    ).toHaveLength(5);
    expect(
      EXPECTED_ROUTES.filter((route) => {
        return route.method === "POST";
      }),
    ).toHaveLength(30);
    for (const permissionName of permissionNames) {
      expect(policy.policies[permissionName], permissionName).toBe(
        DEFAULT_ALLOWED.has(permissionName) ? "allow" : "deny",
      );
    }
    for (const route of EXPECTED_ROUTES) {
      const decision = matchFirewallRequestDecision(
        [firewall],
        route.method,
        `${route.apiBase}${route.path}?probe=value`,
        networkPolicies,
      );
      expect(decision, `${route.method} ${route.path}`).toMatchObject(
        DEFAULT_ALLOWED.has(route.permission)
          ? {
              kind: "allow",
              firewallName: "nintendo-switch-parental-controls",
              permission: route.permission,
            }
          : {
              kind: "block",
              firewallName: "nintendo-switch-parental-controls",
              reason: "permission_denied",
              permissions: [route.permission],
            },
      );
    }
    expect(policy.unknownPolicy).toBe("deny");
  });

  it("denies unknown paths and methods without claiming unsupported hosts", async () => {
    const policy = await loadDefaultFirewallPolicies(
      "nintendo-switch-parental-controls",
    );
    const networkPolicies = matcherNetworkPolicies(policy);
    const unknownRoutes: readonly ExpectedRoute[] = [
      {
        apiBase: ACTION_BASE,
        method: "GET",
        path: "/v2/actions/logout",
        permission: "",
      },
      {
        apiBase: ACTION_BASE,
        method: "POST",
        path: "/v3/actions/user/fetchOwnedDevices",
        permission: "",
      },
      {
        apiBase: ACTION_BASE,
        method: "GET",
        path: "/moon/v1/devices",
        permission: "",
      },
      {
        apiBase: "https://api-lp1.pctl.srv.nintendo.net",
        method: "GET",
        path: "/v2/actions/user/fetchUser",
        permission: "",
      },
    ];

    for (const route of unknownRoutes) {
      expect(matchingPermissions(route)).toStrictEqual([]);
      const decision = matchFirewallRequestDecision(
        [firewall],
        route.method,
        `${route.apiBase}${route.path}`,
        networkPolicies,
      );
      expect(decision, `${route.method} ${route.apiBase}${route.path}`).toEqual(
        route.apiBase === ACTION_BASE
          ? {
              kind: "block",
              firewallName: "nintendo-switch-parental-controls",
              base: ACTION_BASE,
              relativePath: route.path,
              reason: "unknown_endpoint",
              permissions: [],
            }
          : { kind: "no_match" },
      );
    }
  });
});
