/**
 * Shared compiler for hand-authored Google firewall permission manifests.
 *
 * Connector files still own Google Discovery loading and route extraction. This
 * helper only validates and renders vm0 permission manifests against the
 * official route keys produced by those connector-specific adapters.
 */

import {
  escapeString,
  renderCategories,
  renderDefaultAllowed,
  renderDefaultUnknownPolicy,
  renderPermissions,
  sanitizeAndSortRules,
} from "./codegen";
import type { CategoryConfig, PermissionGroup } from "./codegen";

const ROUTE_RULE_PATTERN = /^(GET|HEAD|POST|PUT|PATCH|DELETE) \//;

export interface GoogleManifestPermission {
  readonly name: string;
  readonly category?: string;
  readonly description?: string;
  readonly routeKeys: readonly string[];
}

interface GoogleManifestApiConfig<Kind extends string> {
  readonly base: string;
  readonly kind: Kind;
}

interface CompiledGoogleManifestApi<
  Kind extends string,
> extends GoogleManifestApiConfig<Kind> {
  readonly permissions: readonly PermissionGroup[];
}

interface GoogleManifestCompileConfig<
  Kind extends string,
  Permission extends GoogleManifestPermission,
> {
  readonly serviceLabel: string;
  readonly routeKinds: readonly Kind[];
  readonly officialRouteKeys: ReadonlySet<string>;
  readonly manifest: readonly Permission[];
  readonly apis: readonly GoogleManifestApiConfig<Kind>[];
  readonly categoryOrder?: readonly string[];
}

interface CompiledGoogleManifestFirewall<Kind extends string> {
  readonly apis: readonly CompiledGoogleManifestApi<Kind>[];
  readonly categories?: CategoryConfig;
}

interface GoogleManifestDefaultAllowedConfig {
  readonly varName: string;
  readonly permissions: readonly string[];
}

interface GoogleManifestDefaultUnknownPolicyConfig {
  readonly varName: string;
  readonly policy: "allow" | "deny" | "ask";
}

interface GoogleManifestCategoriesRenderConfig {
  readonly varName: string;
  readonly config: CategoryConfig;
}

interface GoogleManifestRenderConfig<Kind extends string> {
  readonly headerLines: readonly string[];
  readonly firewallVarName: string;
  readonly firewallName: string;
  readonly firewallDescription: string;
  readonly tokenPlaceholderName: string;
  readonly tokenPlaceholderValue: string;
  readonly apis: readonly CompiledGoogleManifestApi<Kind>[];
  readonly defaultAllowed: GoogleManifestDefaultAllowedConfig;
  readonly defaultUnknownPolicy: GoogleManifestDefaultUnknownPolicyConfig;
  readonly categories?: GoogleManifestCategoriesRenderConfig;
}

function sortedValues(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function routeKeyParts<Kind extends string>(
  serviceLabel: string,
  routeKinds: readonly Kind[],
  routeKey: string,
): {
  readonly kind: Kind;
  readonly rule: string;
} {
  const separatorIndex = routeKey.indexOf(":");
  if (separatorIndex === -1) {
    throw new Error(`Malformed ${serviceLabel} route key: ${routeKey}`);
  }

  const rawKind = routeKey.slice(0, separatorIndex);
  const kind = routeKinds.find((candidate) => candidate === rawKind);
  if (!kind) {
    throw new Error(`Unknown ${serviceLabel} route key kind: ${routeKey}`);
  }

  const rule = routeKey.slice(separatorIndex + 1);
  if (!ROUTE_RULE_PATTERN.test(rule)) {
    throw new Error(`Malformed ${serviceLabel} route rule: ${routeKey}`);
  }

  return { kind, rule };
}

function assertUniquePermissionNames<
  Permission extends GoogleManifestPermission,
>(serviceLabel: string, manifest: readonly Permission[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const permission of manifest) {
    if (seen.has(permission.name)) {
      duplicates.add(permission.name);
    }
    seen.add(permission.name);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `${serviceLabel} permission manifest has duplicate permission names:\n${sortedValues(duplicates).join("\n")}`,
    );
  }
}

function assertValidCategories<Permission extends GoogleManifestPermission>(
  serviceLabel: string,
  manifest: readonly Permission[],
  categoryOrder: readonly string[] | undefined,
): void {
  if (!categoryOrder) return;

  const seenCategories = new Set<string>();
  const duplicateCategories = new Set<string>();
  for (const category of categoryOrder) {
    if (seenCategories.has(category)) {
      duplicateCategories.add(category);
    }
    seenCategories.add(category);
  }
  if (duplicateCategories.size > 0) {
    throw new Error(
      `${serviceLabel} category order has duplicate categories:\n${sortedValues(duplicateCategories).join("\n")}`,
    );
  }

  const allowedCategories = new Set(categoryOrder);
  const invalidCategories = new Set<string>();
  const missingCategoryPermissions = new Set<string>();
  for (const permission of manifest) {
    if (!permission.category) {
      missingCategoryPermissions.add(permission.name);
      continue;
    }
    if (!allowedCategories.has(permission.category)) {
      invalidCategories.add(`${permission.name} -> ${permission.category}`);
    }
  }

  const messages: string[] = [];
  if (missingCategoryPermissions.size > 0) {
    messages.push(
      `${serviceLabel} permissions missing categories:\n${sortedValues(missingCategoryPermissions).join("\n")}`,
    );
  }
  if (invalidCategories.size > 0) {
    messages.push(
      `${serviceLabel} permissions reference categories outside display order:\n${sortedValues(invalidCategories).join("\n")}`,
    );
  }
  if (messages.length > 0) {
    throw new Error(messages.join("\n\n"));
  }
}

function collectRouteAssignments<
  Kind extends string,
  Permission extends GoogleManifestPermission,
>(
  serviceLabel: string,
  routeKinds: readonly Kind[],
  manifest: readonly Permission[],
): Map<string, string[]> {
  const assignments = new Map<string, string[]>();
  for (const permission of manifest) {
    for (const routeKey of permission.routeKeys) {
      routeKeyParts(serviceLabel, routeKinds, routeKey);
      const assignedPermissions = assignments.get(routeKey) ?? [];
      assignedPermissions.push(permission.name);
      assignments.set(routeKey, assignedPermissions);
    }
  }
  return assignments;
}

function assertApiKindsMatchRouteKinds<Kind extends string>(
  serviceLabel: string,
  routeKinds: readonly Kind[],
  apis: readonly GoogleManifestApiConfig<Kind>[],
): void {
  const knownKinds = new Set(routeKinds);
  const apiKinds = apis.map((api) => api.kind);
  const unknownKinds = sortedValues(
    apiKinds.filter((kind) => {
      return !knownKinds.has(kind);
    }),
  );
  const missingKinds = sortedValues(
    [...knownKinds].filter((kind) => {
      return !apiKinds.includes(kind);
    }),
  );

  const seenKinds = new Set<Kind>();
  const duplicateKinds = new Set<Kind>();
  for (const kind of apiKinds) {
    if (seenKinds.has(kind)) {
      duplicateKinds.add(kind);
    }
    seenKinds.add(kind);
  }

  const messages: string[] = [];
  if (unknownKinds.length > 0) {
    messages.push(
      `Unknown ${serviceLabel} API route kinds:\n${unknownKinds.join("\n")}`,
    );
  }
  if (missingKinds.length > 0) {
    messages.push(
      `Missing ${serviceLabel} API route kinds:\n${missingKinds.join("\n")}`,
    );
  }
  if (duplicateKinds.size > 0) {
    messages.push(
      `Duplicate ${serviceLabel} API route kinds:\n${sortedValues(duplicateKinds).join("\n")}`,
    );
  }
  if (messages.length > 0) {
    throw new Error(messages.join("\n\n"));
  }
}

function assertRouteKindsAreUnique<Kind extends string>(
  serviceLabel: string,
  routeKinds: readonly Kind[],
): void {
  const seenKinds = new Set<Kind>();
  const duplicateKinds = new Set<Kind>();
  for (const kind of routeKinds) {
    if (seenKinds.has(kind)) {
      duplicateKinds.add(kind);
    }
    seenKinds.add(kind);
  }
  if (duplicateKinds.size > 0) {
    throw new Error(
      `Duplicate ${serviceLabel} route kinds:\n${sortedValues(duplicateKinds).join("\n")}`,
    );
  }
}

function assertOfficialRouteKindsHaveRoutes<Kind extends string>(
  serviceLabel: string,
  routeKinds: readonly Kind[],
  officialRouteKeys: ReadonlySet<string>,
): void {
  const officialKinds = new Set(
    [...officialRouteKeys].map((routeKey) => {
      return routeKeyParts(serviceLabel, routeKinds, routeKey).kind;
    }),
  );
  const missingOfficialKinds = sortedValues(
    routeKinds.filter((kind) => {
      return !officialKinds.has(kind);
    }),
  );
  if (missingOfficialKinds.length > 0) {
    throw new Error(
      `Missing ${serviceLabel} official route kinds:\n${missingOfficialKinds.join("\n")}`,
    );
  }
}

export function validateGoogleManifestPermissionManifest<
  Kind extends string,
  Permission extends GoogleManifestPermission,
>({
  serviceLabel,
  routeKinds,
  officialRouteKeys,
  manifest,
  categoryOrder,
}: Omit<GoogleManifestCompileConfig<Kind, Permission>, "apis">): void {
  assertRouteKindsAreUnique(serviceLabel, routeKinds);
  assertUniquePermissionNames(serviceLabel, manifest);
  assertValidCategories(serviceLabel, manifest, categoryOrder);
  assertOfficialRouteKindsHaveRoutes(
    serviceLabel,
    routeKinds,
    officialRouteKeys,
  );

  const assignments = collectRouteAssignments(
    serviceLabel,
    routeKinds,
    manifest,
  );
  const manifestRouteKeys = new Set(assignments.keys());
  const unknown = sortedValues(
    [...manifestRouteKeys].filter((routeKey) => {
      return !officialRouteKeys.has(routeKey);
    }),
  );
  const missing = sortedValues(
    [...officialRouteKeys].filter((routeKey) => {
      return !manifestRouteKeys.has(routeKey);
    }),
  );
  const duplicates = sortedValues(
    [...assignments.entries()]
      .filter(([, permissions]) => {
        return permissions.length > 1;
      })
      .map(([routeKey, permissions]) => {
        return `${routeKey} -> ${permissions.join(", ")}`;
      }),
  );

  const messages: string[] = [];
  if (unknown.length > 0) {
    messages.push(
      `Unknown ${serviceLabel} manifest route keys:\n${unknown.join("\n")}`,
    );
  }
  if (missing.length > 0) {
    messages.push(
      `Missing ${serviceLabel} manifest route keys:\n${missing.join("\n")}`,
    );
  }
  if (duplicates.length > 0) {
    messages.push(
      `Duplicate ${serviceLabel} manifest route assignments:\n${duplicates.join("\n")}`,
    );
  }
  if (messages.length > 0) {
    throw new Error(messages.join("\n\n"));
  }
}

function buildGoogleManifestPermissionsForKind<
  Kind extends string,
  Permission extends GoogleManifestPermission,
>(
  serviceLabel: string,
  routeKinds: readonly Kind[],
  manifest: readonly Permission[],
  kind: Kind,
): PermissionGroup[] {
  return manifest
    .flatMap((permission) => {
      const rules = permission.routeKeys
        .map((routeKey) => routeKeyParts(serviceLabel, routeKinds, routeKey))
        .filter((routeKey) => {
          return routeKey.kind === kind;
        })
        .map((routeKey) => {
          return routeKey.rule;
        });
      if (rules.length === 0) return [];
      return [
        {
          name: permission.name,
          description: permission.description,
          rules: sanitizeAndSortRules(rules),
        },
      ];
    })
    .sort((left, right) => {
      return left.name.localeCompare(right.name);
    });
}

function buildGoogleManifestCategories<
  Permission extends GoogleManifestPermission,
>(
  serviceLabel: string,
  manifest: readonly Permission[],
  categoryOrder: readonly string[],
): CategoryConfig {
  assertValidCategories(serviceLabel, manifest, categoryOrder);

  const categories: Record<string, string> = {};
  for (const permission of manifest) {
    categories[permission.name] = permission.category ?? "";
  }
  return {
    categories,
    displayOrder: [...categoryOrder],
  };
}

export function compileGoogleManifestFirewall<
  Kind extends string,
  Permission extends GoogleManifestPermission,
>(
  config: GoogleManifestCompileConfig<Kind, Permission>,
): CompiledGoogleManifestFirewall<Kind> {
  validateGoogleManifestPermissionManifest(config);
  assertApiKindsMatchRouteKinds(
    config.serviceLabel,
    config.routeKinds,
    config.apis,
  );

  return {
    apis: config.apis.map((api) => {
      return {
        ...api,
        permissions: buildGoogleManifestPermissionsForKind(
          config.serviceLabel,
          config.routeKinds,
          config.manifest,
          api.kind,
        ),
      };
    }),
    categories: config.categoryOrder
      ? buildGoogleManifestCategories(
          config.serviceLabel,
          config.manifest,
          config.categoryOrder,
        )
      : undefined,
  };
}

export function renderGoogleManifestFirewall<Kind extends string>({
  headerLines,
  firewallVarName,
  firewallName,
  firewallDescription,
  tokenPlaceholderName,
  tokenPlaceholderValue,
  apis,
  defaultAllowed,
  defaultUnknownPolicy,
  categories,
}: GoogleManifestRenderConfig<Kind>): string {
  const lines: string[] = [
    ...headerLines,
    "",
    'import type { FirewallConfig, FirewallPolicyValue } from "../firewall-types";',
    'import type { PermissionNamesOf } from "./index";',
    "",
    `export const ${firewallVarName} = {`,
    `  name: "${escapeString(firewallName)}",`,
    `  description: "${escapeString(firewallDescription)}",`,
    "  placeholders: {",
    `    ${tokenPlaceholderName}: "${escapeString(tokenPlaceholderValue)}",`,
    "  },",
    "  apis: [",
  ];

  for (const api of apis) {
    lines.push("    {");
    lines.push(`      base: "${escapeString(api.base)}",`);
    lines.push("      auth: {");
    lines.push("        headers: {");
    lines.push(
      `          Authorization: "Bearer \${{ secrets.${tokenPlaceholderName} }}",`,
    );
    lines.push("        },");
    lines.push("      },");
    lines.push("      permissions: [");
    lines.push(...renderPermissions([...api.permissions]));
    lines.push("      ],");
    lines.push("    },");
  }

  lines.push("  ],");
  lines.push("} as const satisfies FirewallConfig;");
  lines.push(
    ...renderDefaultAllowed(defaultAllowed.varName, firewallVarName, [
      ...defaultAllowed.permissions,
    ]),
  );
  lines.push(
    ...renderDefaultUnknownPolicy(
      defaultUnknownPolicy.varName,
      defaultUnknownPolicy.policy,
    ),
  );
  if (categories) {
    lines.push(
      ...renderCategories(categories.varName, firewallVarName, {
        categories: categories.config.categories,
        displayOrder: categories.config.displayOrder,
      }),
    );
  }

  return lines.join("\n");
}
