/**
 * Generate PlayStation Network firewall config.
 *
 * Data sources:
 * - latest psn-api source published to npm,
 *   https://www.npmjs.com/package/psn-api
 * - curated endpoints verified against current PlayStation App, Store, and
 *   community-client traffic
 *
 * PlayStation Network's consumer APIs are not documented as a stable public
 * API. The generated baseline follows psn-api while the audited manifest adds
 * concrete capabilities that psn-api does not expose. Unknown paths are denied
 * by default, and sensitive reads and mutations are denied by default.
 */

import ts from "typescript";

import {
  listCachedSpecs,
  logStats,
  renderCategories,
  renderDefaultAllowed,
  renderDefaultUnknownPolicy,
  renderPermissions,
  sanitizeAndSortRules,
  writeOutput,
  type CategoryConfig,
  type PermissionGroup,
} from "./codegen";

export const PLAYSTATION_NPM_PACKAGE_NAME = "psn-api";
export const PLAYSTATION_NPM_LATEST_URL =
  "https://registry.npmjs.org/psn-api/latest";

const PLACEHOLDER_VALUE = "psn_access_token_placeholder";
const PLAYSTATION_RUNTIME_TOKEN_SECRET = "PLAYSTATION_TOKEN";

const PLAYSTATION_MOBILE_API_BASE = "https://m.np.playstation.com";
const PLAYSTATION_COMMUNITY_API_BASE =
  "https://us-prof.np.community.playstation.net";
const PLAYSTATION_WEB_API_BASE = "https://web.np.playstation.com";
const PLAYSTATION_DMS_API_BASE = "https://dms.api.playstation.com";
const PLAYSTATION_ACCOUNTS_API_BASE = "https://accounts.api.playstation.com";
const PLAYSTATION_PUSH_API_BASE =
  "https://mobile-pushcl.np.communication.playstation.net";
const PLAYSTATION_APP_CONFIG_BASE = "https://theia.dl.playstation.net";
const PLAYSTATION_STATIC_RESOURCE_BASE =
  "https://static-resource.np.community.playstation.net";
const PLAYSTATION_BLOG_BASE = "https://blog.playstation.com";
const PLAYSTATION_REGIONAL_BLOG_BASE = "https://{region}.blog.playstation.com";

const PLAYSTATION_API_BASE_ORDER = [
  PLAYSTATION_MOBILE_API_BASE,
  PLAYSTATION_COMMUNITY_API_BASE,
  PLAYSTATION_WEB_API_BASE,
  PLAYSTATION_DMS_API_BASE,
  PLAYSTATION_ACCOUNTS_API_BASE,
  PLAYSTATION_PUSH_API_BASE,
  PLAYSTATION_APP_CONFIG_BASE,
  PLAYSTATION_STATIC_RESOURCE_BASE,
  PLAYSTATION_BLOG_BASE,
  PLAYSTATION_REGIONAL_BLOG_BASE,
] as const;

const PLAYSTATION_API_BASES = new Set<string>(PLAYSTATION_API_BASE_ORDER);
const PLAYSTATION_PUBLIC_API_BASES = new Set<string>([
  PLAYSTATION_APP_CONFIG_BASE,
  PLAYSTATION_STATIC_RESOURCE_BASE,
  PLAYSTATION_BLOG_BASE,
  PLAYSTATION_REGIONAL_BLOG_BASE,
]);

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

function isHttpMethod(value: string): value is HttpMethod {
  return HTTP_METHODS.some((candidate) => {
    return candidate === value;
  });
}

interface PlaystationPermissionRoute {
  readonly method: HttpMethod;
  readonly base: string;
  readonly path: string;
}

interface PlaystationPermissionManifestEntry {
  readonly name: string;
  readonly description: string;
  readonly defaultAllowed: boolean;
  readonly functions?: readonly string[];
  readonly routes?: readonly PlaystationPermissionRoute[];
}

interface PlaystationSourceFile {
  readonly key: string;
  readonly path: string;
  readonly content: string;
}

interface PlaystationSourcePackage {
  readonly version: string;
  readonly files: readonly PlaystationSourceFile[];
}

export interface PlaystationSourceEndpoint {
  readonly functionName: string;
  readonly sourcePath: string;
  readonly method: HttpMethod;
  readonly base: string;
  readonly path: string;
  readonly rule: string;
}

const PLAYSTATION_PERMISSION_MANIFEST: readonly PlaystationPermissionManifestEntry[] =
  [
    {
      name: "playstation-profile-read",
      description: "Read PlayStation Network profile and presence data",
      defaultAllowed: true,
      functions: [
        "getBasicPresence",
        "getProfileFromAccountId",
        "getProfileShareableLink",
      ],
      routes: [
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/userProfile/v2/internal/users/{accountId}/basicPresences",
        },
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/userProfile/v1/internal/users/profiles",
        },
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/userProfile/v2/internal/users/basicPresences",
        },
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/userProfile/v1/internal/users/me/userSettings/appearOffline",
        },
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/cpss/v1/eligibilityCheck/batch",
        },
      ],
    },
    {
      name: "playstation-social-read",
      description:
        "Read PlayStation Network friend, friend request, and block lists",
      defaultAllowed: false,
      functions: [
        "getUserBlockedAccountIds",
        "getUserFriendsAccountIds",
        "getUserFriendsRequests",
      ],
      routes: [
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/userProfile/v2/internal/users/{accountId}/friends",
        },
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/userProfile/v1/internal/users/{accountId}/friends/{friendId}/summary",
        },
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/userProfile/v1/internal/users/me/friends/{accountId}/summary",
        },
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/userProfile/v1/internal/users/me/friends/subscribing/availableToPlay",
        },
      ],
    },
    {
      name: "playstation-games-read",
      description: "Read PlayStation played games and playtime data",
      defaultAllowed: true,
      functions: ["getUserPlayedGames"],
    },
    {
      name: "playstation-trophies-read",
      description:
        "Read PlayStation trophy summaries, titles, groups, and lists",
      defaultAllowed: true,
      functions: [
        "getTitleTrophyGroups",
        "getTitleTrophies",
        "getUserTitles",
        "getUserTrophiesEarnedForTitle",
        "getUserTrophiesForSpecificTitle",
        "getUserTrophyGroupEarningsForTitle",
        "getUserTrophyProfileSummary",
      ],
      routes: [
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/trophy/v1/users/{accountId}/npCommunicationIds/{npCommunicationId}/trophies/{trophyId}",
        },
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/trophy/v1/npCommunicationIds/{npCommunicationId}/trophies/{trophyId}",
        },
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/trophy/v1/users/me/npCommunicationIds/{npCommunicationId}/appearanceSetting",
        },
      ],
    },
    {
      name: "playstation-search-read",
      description: "Search PlayStation Network users and content",
      defaultAllowed: true,
      functions: ["makeUniversalSearch"],
    },
    {
      name: "playstation-legacy-profile-read",
      description: "Read legacy PlayStation Network profile data by online ID",
      defaultAllowed: true,
      functions: ["getProfileFromUserName"],
    },
    {
      name: "playstation-graphql-games-read",
      description:
        "Send persisted PlayStation game library, Store, wishlist, subscription, review, and browse queries through the shared web GraphQL GET transport",
      defaultAllowed: false,
      functions: ["getPurchasedGames", "getRecentlyPlayedGames"],
    },
    {
      name: "playstation-devices-read",
      description: "Read devices associated with a PlayStation Network account",
      defaultAllowed: false,
      functions: ["getAccountDevices"],
    },
    {
      name: "playstation-account-private-read",
      description:
        "Read the connected account's full private record, including contact, identity, birth date, address, locale, and account-state fields",
      defaultAllowed: false,
      routes: [
        {
          method: "GET",
          base: PLAYSTATION_ACCOUNTS_API_BASE,
          path: "/api/v1/accounts/me",
        },
      ],
    },
    {
      name: "playstation-store-catalog-read",
      description: "Read PlayStation Store title-to-concept catalog mappings",
      defaultAllowed: true,
      routes: [
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/catalog/v2/titles/{npTitleId}/concepts",
        },
      ],
    },
    {
      name: "playstation-entitlements-read",
      description:
        "Read the connected account's game, add-on, subscription, and reward entitlement ledger",
      defaultAllowed: false,
      routes: [
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/entitlement/v2/users/me/internal/entitlements",
        },
      ],
    },
    {
      name: "playstation-subscriptions-read",
      description:
        "Read the connected account's PlayStation Plus and partner subscription state",
      defaultAllowed: false,
      routes: [
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/subscriptions/v2/users/me/services/pssubscriptions",
        },
      ],
    },
    {
      name: "playstation-console-storage-read",
      description:
        "Read connected console storage usage and installed-title snapshots",
      defaultAllowed: false,
      routes: [
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/cloudAssistedNavigation/v2/users/me/clients",
        },
      ],
    },
    {
      name: "playstation-media-read",
      description:
        "Read cloud screenshot and video metadata and signed download URLs",
      defaultAllowed: false,
      routes: [
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/gameMediaService/v2/c2s/category/cloudMediaGallery/ugcType/all",
        },
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/gameMediaService/v2/c2s/content",
        },
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/gameMediaService/v2/c2s/ugc/{ugcId}/url",
        },
      ],
    },
    {
      name: "playstation-messaging-read",
      description:
        "Read PlayStation group and direct-message metadata, history, resources, and reactions",
      defaultAllowed: false,
      routes: [
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/gamingLoungeGroups/v1/members/me/groups",
        },
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/gamingLoungeGroups/v1/members/me/groups/{groupId}",
        },
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/gamingLoungeGroups/v1/members/me/groups/{groupId}/threads/{threadId}/messages",
        },
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/gamingLoungeGroups/v1/groups/{groupId}/resources/{resourceId}",
        },
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/gamingLoungeGroups/v1/reactions/mobile-v1/definitions",
        },
      ],
    },
    {
      name: "playstation-sessions-read",
      description:
        "Read PlayStation party invitations and open party-session metadata",
      defaultAllowed: false,
      routes: [
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/sessionManager/v2/users/me/partySessionsInvitations",
        },
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/gamingLoungeGroups/v1/members/me/groups/openPartySessions",
        },
      ],
    },
    {
      name: "playstation-notifications-read",
      description: "Read the connected account's notification inbox",
      defaultAllowed: false,
      routes: [
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/userNotificationManager/v1/users/me/notifications",
        },
      ],
    },
    {
      name: "playstation-push-notifications-read",
      description:
        "Discover the connected account's PlayStation push-notification server",
      defaultAllowed: false,
      routes: [
        {
          method: "GET",
          base: PLAYSTATION_PUSH_API_BASE,
          path: "/np/serveraddr",
        },
      ],
    },
    {
      name: "playstation-personalization-read",
      description:
        "Read the connected account's Explore hub, followed concepts, beta enrollments, and story rails",
      defaultAllowed: false,
      routes: [
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/explore/v2/users/me/hub",
        },
      ],
    },
    {
      name: "playstation-mobile-graphql-read",
      description:
        "Send persisted PlayStation App game, Game Help, Store, search, wishlist, and browse queries through the shared mobile GraphQL GET transport",
      defaultAllowed: false,
      routes: [
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/graphql/v1/op",
        },
      ],
    },
    {
      name: "playstation-operational-metadata-read",
      description:
        "Read PlayStation app configuration, experiment variants, sticker indexes, and blog posts",
      defaultAllowed: true,
      routes: [
        {
          method: "GET",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/univex/v3/platforms/mobile/variants",
        },
        {
          method: "GET",
          base: PLAYSTATION_APP_CONFIG_BASE,
          path: "/metropolis/config/{path+}",
        },
        {
          method: "GET",
          base: PLAYSTATION_STATIC_RESOURCE_BASE,
          path: "/sticker/{path+}",
        },
        {
          method: "GET",
          base: PLAYSTATION_BLOG_BASE,
          path: "/wp-json/wp/v2/{path+}",
        },
        {
          method: "GET",
          base: PLAYSTATION_REGIONAL_BLOG_BASE,
          path: "/wp-json/wp/v2/{path+}",
        },
      ],
    },
    {
      name: "playstation-social-write",
      description:
        "Accept or decline friend requests and remove PlayStation Network friends",
      defaultAllowed: false,
      routes: [
        {
          method: "PUT",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/userProfile/v1/internal/users/me/friends/{accountId}",
        },
        {
          method: "DELETE",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/userProfile/v1/internal/users/me/friends/{accountId}",
        },
      ],
    },
    {
      name: "playstation-messaging-write",
      description:
        "Create or modify message groups, invite or remove members, send messages, upload resources, or leave groups",
      defaultAllowed: false,
      routes: [
        {
          method: "POST",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/gamingLoungeGroups/v1/groups",
        },
        {
          method: "PATCH",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/gamingLoungeGroups/v1/groups/{groupId}",
        },
        {
          method: "POST",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/gamingLoungeGroups/v1/groups/{groupId}/invitees",
        },
        {
          method: "POST",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/gamingLoungeGroups/v1/groups/{groupId}/threads/{threadId}/messages",
        },
        {
          method: "POST",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/gamingLoungeGroups/v1/groups/{groupId}/resources",
        },
        {
          method: "DELETE",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/gamingLoungeGroups/v1/groups/{groupId}/members/{accountId}",
        },
        {
          method: "DELETE",
          base: PLAYSTATION_MOBILE_API_BASE,
          path: "/api/gamingLoungeGroups/v1/groups/{groupId}/members/me",
        },
      ],
    },
    {
      name: "playstation-store-graphql-post",
      description:
        "Send PlayStation Store GraphQL POST operations, including wishlist, eligible library claims, ratings, reviews, votes, and reports",
      defaultAllowed: false,
      routes: [
        {
          method: "POST",
          base: PLAYSTATION_WEB_API_BASE,
          path: "/api/graphql/v1/op",
        },
      ],
    },
  ];

function playstationPermissionCategory(
  permission: PlaystationPermissionManifestEntry,
): string {
  if (
    permission.name.endsWith("-write") ||
    permission.name === "playstation-store-graphql-post"
  ) {
    return "Write";
  }
  return permission.defaultAllowed ? "Read" : "Sensitive read";
}

const PLAYSTATION_CATEGORIES: CategoryConfig = {
  categories: Object.fromEntries(
    PLAYSTATION_PERMISSION_MANIFEST.map((permission) => {
      return [permission.name, playstationPermissionCategory(permission)];
    }),
  ),
  displayOrder: ["Read", "Sensitive read", "Write"],
};

const PLAYSTATION_DEFAULT_ALLOWED = PLAYSTATION_PERMISSION_MANIFEST.filter(
  (permission) => {
    return permission.defaultAllowed;
  },
).map((permission) => {
  return permission.name;
});

interface RequestUrlAssignment {
  readonly variableName: string;
  readonly baseUrl: string;
  readonly endpointUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }
  return null;
}

function collectStringConstants(
  sourceFile: ts.SourceFile,
): ReadonlyMap<string, string> {
  const constants = new Map<string, string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
        continue;
      }

      const value = stringValue(declaration.initializer);
      if (value !== null) {
        constants.set(declaration.name.text, value);
      }
    }
  }

  return constants;
}

function sourcePathFromCacheKey(key: string): string | null {
  const sourceIndex = key.indexOf("/src/");
  if (sourceIndex === -1) {
    return null;
  }

  return key.slice(sourceIndex + 1);
}

function sourceFunctionName(sourcePath: string): string {
  const fileName = sourcePath.split("/").at(-1);
  if (!fileName?.endsWith(".ts")) {
    throw new Error(`Unexpected PlayStation source path: ${sourcePath}`);
  }
  return fileName.slice(0, -".ts".length);
}

function parsePackageVersion(packageJson: string): string {
  const parsed = JSON.parse(packageJson) as unknown;
  if (!isRecord(parsed) || typeof parsed.version !== "string") {
    throw new Error("Cached psn-api package.json does not contain a version");
  }
  return parsed.version;
}

export function loadPlaystationSourcePackage(): PlaystationSourcePackage {
  const cachedSpecs = listCachedSpecs("playstation");
  const packageJson = cachedSpecs.find(({ key }) => {
    return key.endsWith("/package.json");
  });
  if (!packageJson) {
    throw new Error(
      "Cached psn-api package.json not found. Run: pnpm -F @vm0/firewalls-generator update-specs:playstation",
    );
  }

  const files = cachedSpecs.flatMap(({ key, content }) => {
    const sourcePath = sourcePathFromCacheKey(key);
    if (!sourcePath) {
      return [];
    }
    return [{ key, path: sourcePath, content }];
  });

  if (files.length === 0) {
    throw new Error(
      "Cached psn-api source files not found. Run: pnpm -F @vm0/firewalls-generator update-specs:playstation",
    );
  }

  return {
    version: parsePackageVersion(packageJson.content),
    files: files.sort((a, b) => {
      return a.path.localeCompare(b.path);
    }),
  };
}

function resolveString(
  expression: ts.Expression,
  constants: ReadonlyMap<string, string>,
): string | null {
  const literal = stringValue(expression);
  if (literal !== null) {
    return literal;
  }

  if (ts.isIdentifier(expression)) {
    return constants.get(expression.text) ?? null;
  }

  return null;
}

function collectBaseUrlConstants(
  sourceFiles: readonly ts.SourceFile[],
): ReadonlyMap<string, string> {
  const constants = new Map<string, string>();
  for (const sourceFile of sourceFiles) {
    for (const [name, value] of collectStringConstants(sourceFile)) {
      if (URL.canParse(value)) {
        constants.set(name, value);
      }
    }
  }
  return constants;
}

function collectRequestUrlAssignments(
  sourceFile: ts.SourceFile,
  baseUrlConstants: ReadonlyMap<string, string>,
): RequestUrlAssignment[] {
  const assignments: RequestUrlAssignment[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      if (
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === "buildRequestUrl"
      ) {
        const [baseArg, endpointArg] = node.initializer.arguments;
        if (baseArg && endpointArg) {
          const baseUrl = resolveString(baseArg, baseUrlConstants);
          const endpointUrl = stringValue(endpointArg);
          if (baseUrl && endpointUrl !== null) {
            assignments.push({
              variableName: node.name.text,
              baseUrl,
              endpointUrl,
            });
          }
        }
      }

      if (
        ts.isNewExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === "URL"
      ) {
        const [baseArg] = node.initializer.arguments ?? [];
        if (baseArg) {
          const baseUrl = resolveString(baseArg, baseUrlConstants);
          if (baseUrl) {
            assignments.push({
              variableName: node.name.text,
              baseUrl,
              endpointUrl: "",
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return assignments;
}

function objectProperty(
  objectLiteral: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | ts.ShorthandPropertyAssignment | null {
  for (const property of objectLiteral.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      propertyNameText(property.name) === name
    ) {
      return property;
    }
    if (
      ts.isShorthandPropertyAssignment(property) &&
      property.name.text === name
    ) {
      return property;
    }
  }

  return null;
}

function urlPropertyReferencesVariable(
  property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
  variableName: string,
): boolean {
  if (ts.isShorthandPropertyAssignment(property)) {
    return property.name.text === variableName;
  }

  const initializer = property.initializer;
  if (ts.isIdentifier(initializer)) {
    return initializer.text === variableName;
  }

  return (
    ts.isCallExpression(initializer) &&
    ts.isPropertyAccessExpression(initializer.expression) &&
    ts.isIdentifier(initializer.expression.expression) &&
    initializer.expression.expression.text === variableName
  );
}

function requestMethodForUrlVariable(
  sourceFile: ts.SourceFile,
  variableName: string,
): HttpMethod | null {
  let method: HttpMethod | null = null;

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "call"
    ) {
      const [configArg] = node.arguments;
      if (configArg && ts.isObjectLiteralExpression(configArg)) {
        const urlProperty = objectProperty(configArg, "url");
        if (
          urlProperty &&
          urlPropertyReferencesVariable(urlProperty, variableName)
        ) {
          method = "GET";
          const methodProperty = objectProperty(configArg, "method");
          if (methodProperty && ts.isPropertyAssignment(methodProperty)) {
            const value = stringValue(methodProperty.initializer);
            if (value !== null && isHttpMethod(value)) {
              method = value;
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return method;
}

function normalizeEndpoint(args: {
  readonly method: HttpMethod;
  readonly baseUrl: string;
  readonly endpointUrl: string;
}): Omit<PlaystationSourceEndpoint, "functionName" | "sourcePath"> | null {
  const fullUrl =
    args.endpointUrl.length === 0
      ? args.baseUrl
      : `${args.baseUrl}/${args.endpointUrl}`.replace(/([^:]\/)\/+/gu, "$1");
  const url = new URL(fullUrl);
  const base = url.origin;
  if (!PLAYSTATION_API_BASES.has(base)) {
    return null;
  }

  const path = url.pathname.replace(/:([A-Za-z0-9_]+)/gu, "{$1}");
  return {
    method: args.method,
    base,
    path,
    rule: `${args.method} ${path}`,
  };
}

function shouldParseSourceFile(sourcePath: string): boolean {
  return (
    sourcePath.endsWith(".ts") &&
    !sourcePath.endsWith(".test.ts") &&
    !sourcePath.startsWith("src/authenticate/") &&
    !sourcePath.startsWith("src/models/") &&
    !sourcePath.startsWith("src/test/") &&
    !sourcePath.startsWith("src/utils/")
  );
}

export function parsePlaystationSourceEndpoints(
  sourcePackage: PlaystationSourcePackage,
): PlaystationSourceEndpoint[] {
  const sourceFiles = sourcePackage.files
    .filter((file) => {
      return shouldParseSourceFile(file.path);
    })
    .map((file) => {
      return {
        file,
        sourceFile: ts.createSourceFile(
          file.path,
          file.content,
          ts.ScriptTarget.ES2022,
          true,
          ts.ScriptKind.TS,
        ),
      };
    });

  const baseUrlConstants = collectBaseUrlConstants(
    sourceFiles.map(({ sourceFile }) => {
      return sourceFile;
    }),
  );

  const endpoints: PlaystationSourceEndpoint[] = [];
  for (const { file, sourceFile } of sourceFiles) {
    const functionName = sourceFunctionName(file.path);
    for (const assignment of collectRequestUrlAssignments(
      sourceFile,
      baseUrlConstants,
    )) {
      const method = requestMethodForUrlVariable(
        sourceFile,
        assignment.variableName,
      );
      if (!method) {
        continue;
      }

      const endpoint = normalizeEndpoint({
        method,
        baseUrl: assignment.baseUrl,
        endpointUrl: assignment.endpointUrl,
      });
      if (endpoint) {
        endpoints.push({
          functionName,
          sourcePath: file.path,
          ...endpoint,
        });
      }
    }
  }

  return endpoints.sort((a, b) => {
    return (
      a.base.localeCompare(b.base) ||
      a.rule.localeCompare(b.rule) ||
      a.functionName.localeCompare(b.functionName)
    );
  });
}

export function buildPlaystationPermissionsByBase(
  endpoints: readonly PlaystationSourceEndpoint[],
): Map<string, PermissionGroup[]> {
  const endpointsByFunction = new Map<string, PlaystationSourceEndpoint[]>();
  for (const endpoint of endpoints) {
    const functionEndpoints =
      endpointsByFunction.get(endpoint.functionName) ?? [];
    functionEndpoints.push(endpoint);
    endpointsByFunction.set(endpoint.functionName, functionEndpoints);
  }

  const permissionsByBase = new Map<string, PermissionGroup[]>();
  for (const permission of PLAYSTATION_PERMISSION_MANIFEST) {
    const permissionEndpoints = (permission.functions ?? []).flatMap(
      (functionName) => {
        const functionEndpoints = endpointsByFunction.get(functionName);
        if (!functionEndpoints) {
          throw new Error(
            `PlayStation permission ${permission.name} references missing psn-api function: ${functionName}`,
          );
        }
        return functionEndpoints;
      },
    );

    const unsupportedMethods = permissionEndpoints.filter((endpoint) => {
      return (
        endpoint.method !== "GET" &&
        !(
          endpoint.method === "POST" &&
          endpoint.functionName === "makeUniversalSearch"
        )
      );
    });
    if (unsupportedMethods.length > 0) {
      throw new Error(
        `PlayStation permission ${permission.name} contains non-read endpoint methods: ${unsupportedMethods
          .map((endpoint) => {
            return `${endpoint.functionName} ${endpoint.rule}`;
          })
          .join(", ")}`,
      );
    }

    const rulesByBase = new Map<string, string[]>();
    for (const endpoint of permissionEndpoints) {
      const rules = rulesByBase.get(endpoint.base) ?? [];
      rules.push(endpoint.rule);
      rulesByBase.set(endpoint.base, rules);
    }

    for (const route of permission.routes ?? []) {
      if (!PLAYSTATION_API_BASES.has(route.base)) {
        throw new Error(
          `PlayStation permission ${permission.name} references unknown API base: ${route.base}`,
        );
      }
      if (!route.path.startsWith("/") || /[?#]/u.test(route.path)) {
        throw new Error(
          `PlayStation permission ${permission.name} contains invalid route path: ${route.path}`,
        );
      }
      const rules = rulesByBase.get(route.base) ?? [];
      rules.push(`${route.method} ${route.path}`);
      rulesByBase.set(route.base, rules);
    }

    if (rulesByBase.size === 0) {
      throw new Error(
        `PlayStation permission ${permission.name} does not define any endpoint`,
      );
    }

    for (const [base, rules] of rulesByBase) {
      const permissions = permissionsByBase.get(base) ?? [];
      permissions.push({
        name: permission.name,
        description: permission.description,
        rules: sanitizeAndSortRules(rules),
      });
      permissionsByBase.set(base, permissions);
    }
  }

  return permissionsByBase;
}

function sortedApiBases(
  permissionsByBase: ReadonlyMap<string, unknown>,
): string[] {
  const knownBases = PLAYSTATION_API_BASE_ORDER.filter((base) => {
    return permissionsByBase.has(base);
  });
  const additionalBases = [...permissionsByBase.keys()]
    .filter((base) => {
      return !PLAYSTATION_API_BASES.has(base);
    })
    .sort();
  return [...knownBases, ...additionalBases];
}

function renderApi(args: {
  readonly base: string;
  readonly permissions: readonly PermissionGroup[];
}): string[] {
  const auth = PLAYSTATION_PUBLIC_API_BASES.has(args.base)
    ? ["      auth: {},"]
    : [
        "      auth: {",
        "        headers: {",
        `          Authorization: "Bearer \${{ secrets.${PLAYSTATION_RUNTIME_TOKEN_SECRET} }}",`,
        "        },",
        "      },",
      ];
  return [
    "    {",
    `      base: "${args.base}",`,
    ...auth,
    "      permissions: [",
    ...renderPermissions([...args.permissions]),
    "      ],",
    "    },",
  ];
}

function generateTypeScript(args: {
  readonly sourcePackage: PlaystationSourcePackage;
  readonly permissionsByBase: ReadonlyMap<string, readonly PermissionGroup[]>;
}): string {
  const source = `npm:${PLAYSTATION_NPM_PACKAGE_NAME}@${args.sourcePackage.version}`;
  const lines: string[] = [
    "// Auto-generated from psn-api endpoint definitions and audited PlayStation App and Store routes.",
    `// Source: ${source}`,
    "// Update source: cd turbo && pnpm -F @vm0/firewalls-generator update-specs:playstation",
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:playstation",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig, FirewallPolicyValue, PermissionNamesOf } from "../firewall-types";',
    "",
    "export const playstationFirewall = {",
    '  name: "playstation",',
    '  description: "PlayStation Network API",',
    "  placeholders: {",
    `    ${PLAYSTATION_RUNTIME_TOKEN_SECRET}: "${PLACEHOLDER_VALUE}",`,
    "  },",
    "  apis: [",
    ...sortedApiBases(args.permissionsByBase).flatMap((base) => {
      return renderApi({
        base,
        permissions: args.permissionsByBase.get(base) ?? [],
      });
    }),
    "  ],",
    "} as const satisfies FirewallConfig;",
    ...renderDefaultAllowed(
      "playstationDefaultAllowed",
      "playstationFirewall",
      PLAYSTATION_DEFAULT_ALLOWED,
    ),
    ...renderCategories(
      "playstationCategories",
      "playstationFirewall",
      PLAYSTATION_CATEGORIES,
    ),
    ...renderDefaultUnknownPolicy("playstationDefaultUnknownPolicy", "deny"),
  ];
  return lines.join("\n");
}

export async function generate(): Promise<void> {
  console.error("Generating PlayStation firewall config...");
  const sourcePackage = loadPlaystationSourcePackage();
  const endpoints = parsePlaystationSourceEndpoints(sourcePackage);
  const permissionsByBase = buildPlaystationPermissionsByBase(endpoints);
  const ts = generateTypeScript({ sourcePackage, permissionsByBase });
  writeOutput("playstation", ts);
  logStats([...permissionsByBase.values()].flat());
}
