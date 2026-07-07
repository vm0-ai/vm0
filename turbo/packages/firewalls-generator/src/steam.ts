/**
 * Generate Steam Web API firewall config.
 *
 * Data sources:
 * - https://partner.steamgames.com/doc/webapi_overview
 * - https://api.steampowered.com/ISteamWebAPIUtil/GetSupportedAPIList/v1/?format=json
 * - https://partner.steamgames.com/doc/webapi/ISteamUser
 * - https://partner.steamgames.com/doc/webapi/IPlayerService
 * - https://partner.steamgames.com/doc/webapi/ISteamUserStats
 * - https://partner.steamgames.com/doc/webapi/ISteamApps
 * - https://partner.steamgames.com/doc/webapi/ISteamNews
 * - https://partner.steamgames.com/doc/webapi/IStoreService
 *
 * Steam player connector auth uses Steam OpenID to identify the user, then a
 * vm0-owned Steam Web API key for read-only player data requests.
 */

import {
  fetchSpec,
  logStats,
  renderDefaultUnknownPolicy,
  renderPermissions,
  sanitizeAndSortRules,
  writeOutput,
  type PermissionGroup,
} from "./codegen";

const STEAM_WEB_API_OVERVIEW_URL =
  "https://partner.steamgames.com/doc/webapi_overview";
export const STEAM_SUPPORTED_API_LIST_URL =
  "https://api.steampowered.com/ISteamWebAPIUtil/GetSupportedAPIList/v1/?format=json";
export const STEAM_WEB_API_METHOD_DOC_URLS = [
  "https://partner.steamgames.com/doc/webapi/ISteamUser",
  "https://partner.steamgames.com/doc/webapi/IPlayerService",
  "https://partner.steamgames.com/doc/webapi/ISteamUserStats",
  "https://partner.steamgames.com/doc/webapi/ISteamApps",
  "https://partner.steamgames.com/doc/webapi/ISteamNews",
  "https://partner.steamgames.com/doc/webapi/IStoreService",
] as const;
export const STEAM_WEB_API_DOC_URLS = [
  STEAM_WEB_API_OVERVIEW_URL,
  STEAM_SUPPORTED_API_LIST_URL,
  ...STEAM_WEB_API_METHOD_DOC_URLS,
] as const;

const STEAM_API_BASE_URL = "https://api.steampowered.com";
const STEAM_API_HOSTNAME = new URL(STEAM_API_BASE_URL).hostname;
const PLACEHOLDER_VALUE = "C0FFEESAFELOCALC0FFEESAFELOCAL";

interface SteamWebApiEndpoint {
  readonly httpMethod: string;
  readonly interfaceName: string;
  readonly methodName: string;
  readonly version: string;
}

export interface SteamSupportedApiList {
  readonly apilist?: {
    readonly interfaces?: readonly SteamSupportedApiInterface[];
  };
}

interface SteamSupportedApiInterface {
  readonly name?: string;
  readonly methods?: readonly SteamSupportedApiMethod[];
}

interface SteamSupportedApiMethod {
  readonly name?: string;
  readonly version?: number;
  readonly httpmethod?: string;
}

interface SteamPermissionManifestEntry {
  readonly name: string;
  readonly description: string;
  readonly methods: readonly string[];
}

export const STEAM_PERMISSION_MANIFEST: readonly SteamPermissionManifestEntry[] =
  [
    {
      name: "player-profile-read",
      description: "Read Steam profile summaries and vanity URL mappings",
      methods: ["ISteamUser/GetPlayerSummaries", "ISteamUser/ResolveVanityURL"],
    },
    {
      name: "player-library-read",
      description: "Read the connected player owned games library",
      methods: ["IPlayerService/GetOwnedGames"],
    },
    {
      name: "player-activity-read",
      description: "Read connected player recent and per-game playtime",
      methods: [
        "IPlayerService/GetRecentlyPlayedGames",
        "IPlayerService/GetSingleGamePlaytime",
      ],
    },
    {
      name: "player-badges-read",
      description:
        "Read the connected player Steam level, badges, and badge progress",
      methods: [
        "IPlayerService/GetBadges",
        "IPlayerService/GetSteamLevel",
        "IPlayerService/GetCommunityBadgeProgress",
      ],
    },
    {
      name: "player-wishlist-read",
      description: "Read the connected player wishlist",
      methods: [
        "IWishlistService/GetWishlist",
        "IWishlistService/GetWishlistItemCount",
        "IWishlistService/GetWishlistSortedFiltered",
      ],
    },
    {
      name: "player-followed-games-read",
      description: "Read the connected player followed games",
      methods: [
        "IStoreService/GetGamesFollowed",
        "IStoreService/GetGamesFollowedCount",
      ],
    },
    {
      name: "player-friends-read",
      description: "Read the connected player friend list",
      methods: ["ISteamUser/GetFriendList"],
    },
    {
      name: "player-groups-read",
      description: "Read the connected player group list",
      methods: ["ISteamUser/GetUserGroupList"],
    },
    {
      name: "player-ban-status-read",
      description: "Read the connected player ban status",
      methods: ["ISteamUser/GetPlayerBans"],
    },
    {
      name: "player-game-achievements-read",
      description: "Read player and global achievements for a specific game",
      methods: [
        "ISteamUserStats/GetPlayerAchievements",
        "ISteamUserStats/GetGlobalAchievementPercentagesForApp",
      ],
    },
    {
      name: "player-game-stats-read",
      description: "Read player, global, and schema stats for a specific game",
      methods: [
        "ISteamUserStats/GetUserStatsForGame",
        "ISteamUserStats/GetSchemaForGame",
        "ISteamUserStats/GetGlobalStatsForGame",
        "ISteamUserStats/GetNumberOfCurrentPlayers",
      ],
    },
    {
      name: "steam-apps-read",
      description: "Read public Steam app metadata and version status",
      methods: [
        "ISteamApps/GetAppList",
        "IStoreService/GetAppList",
        "ISteamApps/GetSDRConfig",
        "ISteamApps/GetServersAtAddress",
        "ISteamApps/UpToDateCheck",
      ],
    },
    {
      name: "steam-news-read",
      description: "Read public Steam news for an app",
      methods: ["ISteamNews/GetNewsForApp"],
    },
  ];

export function parseSteamWebApiEndpoints(
  htmlDocuments: readonly string[],
): SteamWebApiEndpoint[] {
  const endpoints: SteamWebApiEndpoint[] = [];
  const endpointPattern =
    /\b(?<httpMethod>GET|POST|PUT|PATCH|DELETE)\s+https:\/\/(?:api\.steampowered\.com|partner\.steam-api\.com)\/(?<interfaceName>[A-Za-z0-9_]+)\/(?<methodName>[A-Za-z0-9_]+)\/(?<version>v\d+)\/?/gu;

  for (const html of htmlDocuments) {
    for (const match of html.matchAll(endpointPattern)) {
      const groups = match.groups;
      if (!groups) {
        continue;
      }
      endpoints.push({
        httpMethod: groups.httpMethod!,
        interfaceName: groups.interfaceName!,
        methodName: groups.methodName!,
        version: groups.version!,
      });
    }
  }

  return endpoints;
}

function methodKey(endpoint: SteamWebApiEndpoint): string {
  return `${endpoint.interfaceName}/${endpoint.methodName}`;
}

function pathVariants(endpoint: SteamWebApiEndpoint): string[] {
  const versionNumber = Number(endpoint.version.slice(1));
  const versions = new Set([endpoint.version]);
  if (Number.isSafeInteger(versionNumber) && versionNumber > 0) {
    versions.add(`v${versionNumber}`);
    versions.add(`v${String(versionNumber).padStart(4, "0")}`);
  }

  const paths = new Set<string>();
  for (const version of versions) {
    const path = `/${endpoint.interfaceName}/${endpoint.methodName}/${version}`;
    paths.add(`${endpoint.httpMethod} ${path}`);
    paths.add(`${endpoint.httpMethod} ${path}/`);
  }
  return [...paths];
}

export function buildSteamOfficialMethodRules(
  endpoints: readonly SteamWebApiEndpoint[],
): Map<string, string[]> {
  const rulesByMethod = new Map<string, Set<string>>();

  for (const endpoint of endpoints) {
    const key = methodKey(endpoint);
    const rules = rulesByMethod.get(key) ?? new Set<string>();
    for (const rule of pathVariants(endpoint)) {
      rules.add(rule);
    }
    rulesByMethod.set(key, rules);
  }

  return new Map(
    [...rulesByMethod.entries()].map(([key, rules]) => [
      key,
      sanitizeAndSortRules([...rules]),
    ]),
  );
}

export function parseSteamSupportedApiListEndpoints(
  supportedApiList: SteamSupportedApiList,
): SteamWebApiEndpoint[] {
  return (
    supportedApiList.apilist?.interfaces?.flatMap((apiInterface) => {
      const interfaceName = apiInterface.name;
      if (!interfaceName) {
        return [];
      }

      return (
        apiInterface.methods?.flatMap((method) => {
          if (!method.name || !method.httpmethod || !method.version) {
            return [];
          }

          return [
            {
              httpMethod: method.httpmethod.toUpperCase(),
              interfaceName,
              methodName: method.name,
              version: `v${method.version}`,
            },
          ];
        }) ?? []
      );
    }) ?? []
  );
}

export function validateSteamPermissionManifest(
  officialMethodRules: ReadonlyMap<string, readonly string[]>,
  manifest: readonly SteamPermissionManifestEntry[],
): void {
  const missingMethods = manifest
    .flatMap((permission) => [...permission.methods])
    .filter((method) => !officialMethodRules.has(method));

  if (missingMethods.length > 0) {
    throw new Error(
      `Steam permission manifest references unknown official methods: ${[
        ...new Set(missingMethods),
      ].join(", ")}`,
    );
  }
}

export function buildSteamPermissions(
  officialMethodRules: ReadonlyMap<string, readonly string[]>,
): PermissionGroup[] {
  validateSteamPermissionManifest(
    officialMethodRules,
    STEAM_PERMISSION_MANIFEST,
  );

  return STEAM_PERMISSION_MANIFEST.map((permission) => {
    const rules = permission.methods.flatMap((method) => {
      return [...officialMethodRules.get(method)!];
    });
    const writeRules = rules.filter((rule) => !rule.startsWith("GET "));
    if (writeRules.length > 0) {
      throw new Error(
        `Steam permission ${permission.name} is expected to be read-only but contains non-GET rules: ${writeRules.join(", ")}`,
      );
    }

    return {
      name: permission.name,
      description: permission.description,
      rules: sanitizeAndSortRules(rules),
    };
  });
}

function steamOverviewDocumentsApiHost(html: string): boolean {
  const urlPattern = /https?:\/\/[^\s"'<>]+/giu;
  for (const match of html.matchAll(urlPattern)) {
    if (
      URL.canParse(match[0]) &&
      new URL(match[0]).hostname === STEAM_API_HOSTNAME
    ) {
      return true;
    }
  }
  return false;
}

export function validateSteamOverview(html: string): void {
  if (!steamOverviewDocumentsApiHost(html)) {
    throw new Error(
      "Steam Web API overview no longer documents api.steampowered.com",
    );
  }
}

async function loadSteamPermissions(): Promise<PermissionGroup[]> {
  const overviewResponse = await fetchSpec(
    STEAM_WEB_API_OVERVIEW_URL,
    "Steam Web API overview",
  );
  validateSteamOverview(await overviewResponse.text());

  const methodDocs: string[] = [];
  for (const url of STEAM_WEB_API_METHOD_DOC_URLS) {
    const response = await fetchSpec(url, `Steam Web API docs page ${url}`);
    methodDocs.push(await response.text());
  }
  const supportedApiListResponse = await fetchSpec(
    STEAM_SUPPORTED_API_LIST_URL,
    "Steam supported Web API list",
  );
  const supportedApiList =
    (await supportedApiListResponse.json()) as SteamSupportedApiList;

  const officialMethodRules = buildSteamOfficialMethodRules([
    ...parseSteamWebApiEndpoints(methodDocs),
    ...parseSteamSupportedApiListEndpoints(supportedApiList),
  ]);
  return buildSteamPermissions(officialMethodRules);
}

function generateTypeScript(permissions: readonly PermissionGroup[]): string {
  const sources = STEAM_WEB_API_DOC_URLS.join(", ");

  const lines: string[] = [
    "// Auto-generated from Steam Web API docs.",
    `// Sources: ${sources}`,
    "// Update sources: cd turbo && pnpm -F @vm0/firewalls-generator update-specs:steam",
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:steam",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig, FirewallPolicyValue } from "../firewall-types";',
    "",
    "export const steamFirewall = {",
    '  name: "steam",',
    '  description: "Steam Web API",',
    "  placeholders: {",
    `    STEAM_WEB_API_KEY: "${PLACEHOLDER_VALUE}",`,
    "  },",
    "  apis: [",
    "    {",
    `      base: "${STEAM_API_BASE_URL}",`,
    "      auth: {",
    "        query: {",
    '          key: "${{ secrets.STEAM_WEB_API_KEY }}",',
    "        },",
    "      },",
    "      permissions: [",
    ...renderPermissions([...permissions]),
    "      ],",
    "    },",
    "  ],",
    "} as const satisfies FirewallConfig;",
    ...renderDefaultUnknownPolicy("steamDefaultUnknownPolicy", "deny"),
  ];
  return lines.join("\n");
}

export async function generate(): Promise<void> {
  console.error("Generating Steam firewall config...");
  const permissions = await loadSteamPermissions();
  const ts = generateTypeScript(permissions);
  writeOutput("steam", ts);
  logStats([...permissions]);
}
