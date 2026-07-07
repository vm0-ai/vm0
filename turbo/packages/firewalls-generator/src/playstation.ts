/**
 * Generate PlayStation Network firewall config.
 *
 * Data source: latest psn-api source published to npm,
 * https://www.npmjs.com/package/psn-api
 *
 * PlayStation Network's consumer APIs are not documented as a stable public API.
 * This curated read-only firewall follows the endpoints currently exposed by
 * psn-api and denies unknown paths by default.
 */

import ts from "typescript";

import {
  listCachedSpecs,
  logStats,
  renderDefaultUnknownPolicy,
  renderPermissions,
  sanitizeAndSortRules,
  writeOutput,
  type PermissionGroup,
} from "./codegen";

export const PLAYSTATION_NPM_PACKAGE_NAME = "psn-api";
export const PLAYSTATION_NPM_LATEST_URL =
  "https://registry.npmjs.org/psn-api/latest";

const PLACEHOLDER_VALUE = "psn_access_token_placeholder";
const PLAYSTATION_RUNTIME_TOKEN_SECRET = "PLAYSTATION_TOKEN";

const PLAYSTATION_API_BASE_ORDER = [
  "https://m.np.playstation.com",
  "https://us-prof.np.community.playstation.net",
  "https://web.np.playstation.com",
  "https://dms.api.playstation.com",
] as const;

const PLAYSTATION_API_BASES = new Set<string>(PLAYSTATION_API_BASE_ORDER);

type HttpMethod = "GET" | "POST";

interface PlaystationPermissionManifestEntry {
  readonly name: string;
  readonly description: string;
  readonly functions: readonly string[];
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
      functions: [
        "getBasicPresence",
        "getProfileFromAccountId",
        "getProfileShareableLink",
      ],
    },
    {
      name: "playstation-social-read",
      description:
        "Read PlayStation Network friend, friend request, and block lists",
      functions: [
        "getUserBlockedAccountIds",
        "getUserFriendsAccountIds",
        "getUserFriendsRequests",
      ],
    },
    {
      name: "playstation-games-read",
      description: "Read PlayStation played games and playtime data",
      functions: ["getUserPlayedGames"],
    },
    {
      name: "playstation-trophies-read",
      description:
        "Read PlayStation trophy summaries, titles, groups, and lists",
      functions: [
        "getTitleTrophyGroups",
        "getTitleTrophies",
        "getUserTitles",
        "getUserTrophiesEarnedForTitle",
        "getUserTrophiesForSpecificTitle",
        "getUserTrophyGroupEarningsForTitle",
        "getUserTrophyProfileSummary",
      ],
    },
    {
      name: "playstation-search-read",
      description: "Search PlayStation Network users and content",
      functions: ["makeUniversalSearch"],
    },
    {
      name: "playstation-legacy-profile-read",
      description: "Read legacy PlayStation Network profile data by online ID",
      functions: ["getProfileFromUserName"],
    },
    {
      name: "playstation-graphql-games-read",
      description:
        "Read PlayStation purchased and recently played game lists through psn-api GraphQL operations",
      functions: ["getPurchasedGames", "getRecentlyPlayedGames"],
    },
    {
      name: "playstation-devices-read",
      description: "Read devices associated with a PlayStation Network account",
      functions: ["getAccountDevices"],
    },
  ];

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
            if (value === "GET" || value === "POST") {
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
    const permissionEndpoints = permission.functions.flatMap((functionName) => {
      const functionEndpoints = endpointsByFunction.get(functionName);
      if (!functionEndpoints) {
        throw new Error(
          `PlayStation permission ${permission.name} references missing psn-api function: ${functionName}`,
        );
      }
      return functionEndpoints;
    });

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

    const endpointsByBase = new Map<string, PlaystationSourceEndpoint[]>();
    for (const endpoint of permissionEndpoints) {
      const baseEndpoints = endpointsByBase.get(endpoint.base) ?? [];
      baseEndpoints.push(endpoint);
      endpointsByBase.set(endpoint.base, baseEndpoints);
    }

    for (const [base, baseEndpoints] of endpointsByBase) {
      const permissions = permissionsByBase.get(base) ?? [];
      permissions.push({
        name: permission.name,
        description: permission.description,
        rules: sanitizeAndSortRules(
          baseEndpoints.map((endpoint) => {
            return endpoint.rule;
          }),
        ),
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
  return [
    "    {",
    `      base: "${args.base}",`,
    "      auth: {",
    "        headers: {",
    `          Authorization: "Bearer \${{ secrets.${PLAYSTATION_RUNTIME_TOKEN_SECRET} }}",`,
    "        },",
    "      },",
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
    "// Auto-generated from latest psn-api endpoint definitions.",
    `// Source: ${source}`,
    "// Update source: cd turbo && pnpm -F @vm0/firewalls-generator update-specs:playstation",
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:playstation",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig, FirewallPolicyValue } from "../firewall-types";',
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
