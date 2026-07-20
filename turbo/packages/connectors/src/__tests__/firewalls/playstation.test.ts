import { beforeAll, describe, expect, it } from "vitest";

import {
  findMatchingPermissions,
  matchFirewallRequestDecision,
} from "../../firewall-rule-matcher";
import {
  extractSecretNamesFromApis,
  type FirewallConfig,
  type FirewallPolicy,
  type NetworkPolicies,
} from "../../firewall-types";
import {
  loadDefaultFirewallPolicies,
  loadRequiredConnectorFirewall,
} from "../firewall-test-helpers";

const MOBILE_BASE = "https://m.np.playstation.com";
const COMMUNITY_BASE = "https://us-prof.np.community.playstation.net";
const WEB_BASE = "https://web.np.playstation.com";
const DMS_BASE = "https://dms.api.playstation.com";
const ACCOUNTS_BASE = "https://accounts.api.playstation.com";
const PUSH_BASE = "https://mobile-pushcl.np.communication.playstation.net";
const APP_CONFIG_BASE = "https://theia.dl.playstation.net";
const STATIC_RESOURCE_BASE =
  "https://static-resource.np.community.playstation.net";
const BLOG_BASE = "https://blog.playstation.com";
const REGIONAL_BLOG_BASE = "https://{region}.blog.playstation.com";

interface ExpectedRoute {
  readonly apiBase: string;
  readonly permission: string;
  readonly rule: string;
}

function expectedRoutes(
  apiBase: string,
  permission: string,
  rules: readonly string[],
): ExpectedRoute[] {
  return rules.map((rule) => {
    return { apiBase, permission, rule };
  });
}

const EXPECTED_ROUTES: readonly ExpectedRoute[] = [
  ...expectedRoutes(MOBILE_BASE, "playstation-profile-read", [
    "GET /api/cpss/v1/eligibilityCheck/batch",
    "GET /api/cpss/v1/share/profile/{accountId}",
    "GET /api/userProfile/v1/internal/users/me/userSettings/appearOffline",
    "GET /api/userProfile/v1/internal/users/profiles",
    "GET /api/userProfile/v1/internal/users/{accountId}/basicPresences",
    "GET /api/userProfile/v1/internal/users/{accountId}/profiles",
    "GET /api/userProfile/v2/internal/users/basicPresences",
    "GET /api/userProfile/v2/internal/users/{accountId}/basicPresences",
  ]),
  ...expectedRoutes(MOBILE_BASE, "playstation-social-read", [
    "GET /api/userProfile/v1/internal/users/me/friends/subscribing/availableToPlay",
    "GET /api/userProfile/v1/internal/users/me/friends/{accountId}/summary",
    "GET /api/userProfile/v1/internal/users/{accountId}/blocks",
    "GET /api/userProfile/v1/internal/users/{accountId}/friends",
    "GET /api/userProfile/v1/internal/users/{accountId}/friends/receivedRequests",
    "GET /api/userProfile/v1/internal/users/{accountId}/friends/{friendId}/summary",
    "GET /api/userProfile/v2/internal/users/{accountId}/friends",
  ]),
  ...expectedRoutes(MOBILE_BASE, "playstation-games-read", [
    "GET /api/gamelist/v2/users/{accountId}/titles",
  ]),
  ...expectedRoutes(MOBILE_BASE, "playstation-trophies-read", [
    "GET /api/trophy/v1/npCommunicationIds/{npCommunicationId}/trophies/{trophyId}",
    "GET /api/trophy/v1/npCommunicationIds/{npCommunicationId}/trophyGroups",
    "GET /api/trophy/v1/npCommunicationIds/{npCommunicationId}/trophyGroups/{trophyGroupId}/trophies",
    "GET /api/trophy/v1/users/me/npCommunicationIds/{npCommunicationId}/appearanceSetting",
    "GET /api/trophy/v1/users/{accountId}/npCommunicationIds/{npCommunicationId}/trophies/{trophyId}",
    "GET /api/trophy/v1/users/{accountId}/npCommunicationIds/{npCommunicationId}/trophyGroups",
    "GET /api/trophy/v1/users/{accountId}/npCommunicationIds/{npCommunicationId}/trophyGroups/{trophyGroupId}/trophies",
    "GET /api/trophy/v1/users/{accountId}/titles/trophyTitles",
    "GET /api/trophy/v1/users/{accountId}/trophySummary",
    "GET /api/trophy/v1/users/{accountId}/trophyTitles",
  ]),
  ...expectedRoutes(MOBILE_BASE, "playstation-search-read", [
    "POST /api/search/v1/universalSearch",
  ]),
  ...expectedRoutes(MOBILE_BASE, "playstation-store-catalog-read", [
    "GET /api/catalog/v2/titles/{npTitleId}/concepts",
  ]),
  ...expectedRoutes(MOBILE_BASE, "playstation-entitlements-read", [
    "GET /api/entitlement/v2/users/me/internal/entitlements",
  ]),
  ...expectedRoutes(MOBILE_BASE, "playstation-subscriptions-read", [
    "GET /api/subscriptions/v2/users/me/services/pssubscriptions",
  ]),
  ...expectedRoutes(MOBILE_BASE, "playstation-console-storage-read", [
    "GET /api/cloudAssistedNavigation/v2/users/me/clients",
  ]),
  ...expectedRoutes(MOBILE_BASE, "playstation-media-read", [
    "GET /api/gameMediaService/v2/c2s/category/cloudMediaGallery/ugcType/all",
    "GET /api/gameMediaService/v2/c2s/content",
    "GET /api/gameMediaService/v2/c2s/ugc/{ugcId}/url",
  ]),
  ...expectedRoutes(MOBILE_BASE, "playstation-messaging-read", [
    "GET /api/gamingLoungeGroups/v1/groups/{groupId}/resources/{resourceId}",
    "GET /api/gamingLoungeGroups/v1/members/me/groups",
    "GET /api/gamingLoungeGroups/v1/members/me/groups/{groupId}",
    "GET /api/gamingLoungeGroups/v1/members/me/groups/{groupId}/threads/{threadId}/messages",
    "GET /api/gamingLoungeGroups/v1/reactions/mobile-v1/definitions",
  ]),
  ...expectedRoutes(MOBILE_BASE, "playstation-sessions-read", [
    "GET /api/gamingLoungeGroups/v1/members/me/groups/openPartySessions",
    "GET /api/sessionManager/v2/users/me/partySessionsInvitations",
  ]),
  ...expectedRoutes(MOBILE_BASE, "playstation-notifications-read", [
    "GET /api/userNotificationManager/v1/users/me/notifications",
  ]),
  ...expectedRoutes(MOBILE_BASE, "playstation-personalization-read", [
    "GET /api/explore/v2/users/me/hub",
  ]),
  ...expectedRoutes(MOBILE_BASE, "playstation-mobile-graphql-read", [
    "GET /api/graphql/v1/op",
  ]),
  ...expectedRoutes(MOBILE_BASE, "playstation-operational-metadata-read", [
    "GET /api/univex/v3/platforms/mobile/variants",
  ]),
  ...expectedRoutes(MOBILE_BASE, "playstation-social-write", [
    "DELETE /api/userProfile/v1/internal/users/me/friends/{accountId}",
    "PUT /api/userProfile/v1/internal/users/me/friends/{accountId}",
  ]),
  ...expectedRoutes(MOBILE_BASE, "playstation-messaging-write", [
    "DELETE /api/gamingLoungeGroups/v1/groups/{groupId}/members/me",
    "DELETE /api/gamingLoungeGroups/v1/groups/{groupId}/members/{accountId}",
    "PATCH /api/gamingLoungeGroups/v1/groups/{groupId}",
    "POST /api/gamingLoungeGroups/v1/groups",
    "POST /api/gamingLoungeGroups/v1/groups/{groupId}/invitees",
    "POST /api/gamingLoungeGroups/v1/groups/{groupId}/resources",
    "POST /api/gamingLoungeGroups/v1/groups/{groupId}/threads/{threadId}/messages",
  ]),
  ...expectedRoutes(COMMUNITY_BASE, "playstation-legacy-profile-read", [
    "GET /userProfile/v1/users/{userName}/profile2",
  ]),
  ...expectedRoutes(WEB_BASE, "playstation-graphql-games-read", [
    "GET /api/graphql/v1/op",
  ]),
  ...expectedRoutes(WEB_BASE, "playstation-store-graphql-post", [
    "POST /api/graphql/v1/op",
  ]),
  ...expectedRoutes(DMS_BASE, "playstation-devices-read", [
    "GET /api/v1/devices/accounts/{accountId}",
  ]),
  ...expectedRoutes(ACCOUNTS_BASE, "playstation-account-private-read", [
    "GET /api/v1/accounts/me",
  ]),
  ...expectedRoutes(PUSH_BASE, "playstation-push-notifications-read", [
    "GET /np/serveraddr",
  ]),
  ...expectedRoutes(APP_CONFIG_BASE, "playstation-operational-metadata-read", [
    "GET /metropolis/config/{path+}",
  ]),
  ...expectedRoutes(
    STATIC_RESOURCE_BASE,
    "playstation-operational-metadata-read",
    ["GET /sticker/{path+}"],
  ),
  ...expectedRoutes(BLOG_BASE, "playstation-operational-metadata-read", [
    "GET /wp-json/wp/v2/{path+}",
  ]),
  ...expectedRoutes(
    REGIONAL_BLOG_BASE,
    "playstation-operational-metadata-read",
    ["GET /wp-json/wp/v2/{path+}"],
  ),
];

const PUBLIC_BASES = new Set([
  APP_CONFIG_BASE,
  STATIC_RESOURCE_BASE,
  BLOG_BASE,
  REGIONAL_BLOG_BASE,
]);

const DEFAULT_ALLOWED = [
  "playstation-games-read",
  "playstation-legacy-profile-read",
  "playstation-operational-metadata-read",
  "playstation-profile-read",
  "playstation-search-read",
  "playstation-store-catalog-read",
  "playstation-trophies-read",
];

let firewall: FirewallConfig;
let defaultPolicy: FirewallPolicy;

function routeKey(route: ExpectedRoute): string {
  return `${route.apiBase} ${route.rule} ${route.permission}`;
}

function sortedRoutes(routes: readonly ExpectedRoute[]): ExpectedRoute[] {
  return [...routes].sort((a, b) => {
    return routeKey(a).localeCompare(routeKey(b));
  });
}

function actualRoutes(): ExpectedRoute[] {
  return firewall.apis.flatMap((api) => {
    return (api.permissions ?? []).flatMap((permission) => {
      return permission.rules.map((rule) => {
        return {
          apiBase: api.base,
          permission: permission.name,
          rule,
        };
      });
    });
  });
}

function expectPlaystationMatches(
  apiBase: string,
  method: string,
  path: string,
  permissionNames: readonly string[],
): void {
  expect(
    [
      ...findMatchingPermissions(method, path, firewall, {
        apiBase,
      }),
    ].sort(),
  ).toStrictEqual([...permissionNames].sort());
}

function matcherNetworkPolicies(policy: FirewallPolicy): NetworkPolicies {
  const allow: string[] = [];
  const deny: string[] = [];
  const ask: string[] = [];
  for (const [permission, value] of Object.entries(policy.policies)) {
    if (value === "allow") {
      allow.push(permission);
    }
    if (value === "deny") {
      deny.push(permission);
    }
    if (value === "ask") {
      ask.push(permission);
    }
  }
  return {
    playstation: {
      allow,
      deny,
      ask,
      unknownPolicy: policy.unknownPolicy ?? "allow",
    },
  };
}

function runtimeUrl(route: ExpectedRoute): {
  readonly method: string;
  readonly url: string;
} {
  const separator = route.rule.indexOf(" ");
  const method = route.rule.slice(0, separator);
  const path = route.rule.slice(separator + 1).replace(/\{[^}]+\}/gu, "value");
  const apiBase = route.apiBase.replace(/\{[^}]+\}/gu, "fr");
  return { method, url: `${apiBase}${path}?probe=value` };
}

describe("PlayStation firewall", () => {
  beforeAll(async () => {
    [firewall, defaultPolicy] = await Promise.all([
      loadRequiredConnectorFirewall("playstation"),
      loadDefaultFirewallPolicies("playstation"),
    ]);
  });

  it("registers every audited PlayStation route under one permission", () => {
    expect(sortedRoutes(actualRoutes())).toStrictEqual(
      sortedRoutes(EXPECTED_ROUTES),
    );
  });

  it("injects the runtime token only into authenticated PlayStation APIs", () => {
    expect(firewall.name).toBe("playstation");
    for (const api of firewall.apis) {
      expect(api.auth).toStrictEqual(
        PUBLIC_BASES.has(api.base)
          ? {}
          : {
              headers: {
                Authorization: "Bearer ${{ secrets.PLAYSTATION_TOKEN }}",
              },
            },
      );
    }
    expect(extractSecretNamesFromApis([...firewall.apis])).toStrictEqual([
      "PLAYSTATION_TOKEN",
    ]);
  });

  it("allows only low-risk read permissions by default", () => {
    const allowed = Object.entries(defaultPolicy.policies)
      .filter(([, policy]) => {
        return policy === "allow";
      })
      .map(([name]) => {
        return name;
      })
      .sort();

    expect(allowed).toStrictEqual([...DEFAULT_ALLOWED].sort());
    expect(defaultPolicy.policies["playstation-account-private-read"]).toBe(
      "deny",
    );
    expect(defaultPolicy.policies["playstation-graphql-games-read"]).toBe(
      "deny",
    );
    expect(defaultPolicy.policies["playstation-messaging-read"]).toBe("deny");
    expect(defaultPolicy.policies["playstation-social-write"]).toBe("deny");
    expect(defaultPolicy.policies["playstation-messaging-write"]).toBe("deny");
    expect(defaultPolicy.policies["playstation-store-graphql-post"]).toBe(
      "deny",
    );
    expect(defaultPolicy.unknownPolicy).toBe("deny");
  });

  it("enforces the default policy for every audited runtime route", () => {
    const networkPolicies = matcherNetworkPolicies(defaultPolicy);
    const defaultAllowed = new Set(DEFAULT_ALLOWED);

    for (const route of EXPECTED_ROUTES) {
      const request = runtimeUrl(route);
      const decision = matchFirewallRequestDecision(
        [firewall],
        request.method,
        request.url,
        networkPolicies,
      );
      expect(decision, routeKey(route)).toMatchObject(
        defaultAllowed.has(route.permission)
          ? {
              kind: "allow",
              firewallName: "playstation",
              permission: route.permission,
            }
          : {
              kind: "block",
              firewallName: "playstation",
              reason: "permission_denied",
              permissions: [route.permission],
            },
      );
    }
  });

  it("distinguishes the mobile and web GraphQL transports", () => {
    expectPlaystationMatches(MOBILE_BASE, "GET", "/api/graphql/v1/op", [
      "playstation-mobile-graphql-read",
    ]);
    expectPlaystationMatches(WEB_BASE, "GET", "/api/graphql/v1/op", [
      "playstation-graphql-games-read",
    ]);
    expectPlaystationMatches(WEB_BASE, "POST", "/api/graphql/v1/op", [
      "playstation-store-graphql-post",
    ]);
  });

  it("matches sensitive reads and mutations only on their audited methods", () => {
    expectPlaystationMatches(ACCOUNTS_BASE, "GET", "/api/v1/accounts/me", [
      "playstation-account-private-read",
    ]);
    expectPlaystationMatches(
      MOBILE_BASE,
      "GET",
      "/api/gamingLoungeGroups/v1/members/me/groups/group-1/threads/thread-1/messages",
      ["playstation-messaging-read"],
    );
    expectPlaystationMatches(
      MOBILE_BASE,
      "POST",
      "/api/gamingLoungeGroups/v1/groups/group-1/threads/thread-1/messages",
      ["playstation-messaging-write"],
    );
    expectPlaystationMatches(
      MOBILE_BASE,
      "DELETE",
      "/api/userProfile/v1/internal/users/me/friends/12345",
      ["playstation-social-write"],
    );
    expectPlaystationMatches(
      MOBILE_BASE,
      "POST",
      "/api/userProfile/v1/internal/users/me/friends/12345",
      [],
    );
  });

  it("keeps unknown PlayStation paths outside every permission", () => {
    expectPlaystationMatches(MOBILE_BASE, "GET", "/api/unknown", []);
    expectPlaystationMatches(WEB_BASE, "DELETE", "/api/graphql/v1/op", []);
  });
});
