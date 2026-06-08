/**
 * Generate Stripe firewall config from official Stripe API data.
 *
 * Data sources:
 * - https://github.com/stripe/openapi
 * - https://docs.stripe.com/stripe-apps/reference/permissions
 *
 * The OpenAPI spec provides official path/method rules. The permissions
 * reference provides official Stripe permission names. Stripe does not publish
 * a direct operation-to-permission map in the public GA OpenAPI spec, so this
 * generator maps operations through either unambiguous OpenAPI x-resourceId
 * schemas or endpoint lists from official API docs linked by the permissions
 * reference.
 *
 * Token format (gitleaks: stripe-access-token):
 *   (sk|rk)_(test|live|prod)_ + 10-99 alphanumeric chars
 */

import {
  ALL_METHODS,
  OPENAPI_PATH_KEYS,
  escapeString,
  fetchSpec,
  logStats,
  renderPermissions,
  sanitizeAndSortRules,
  writeOutput,
} from "./codegen";
import type { PermissionGroup } from "./codegen";
import {
  STRIPE_OPENAPI_URL,
  STRIPE_PERMISSIONS_URL,
  stripeApiDocUrlsFromDescription,
} from "./stripe-sources";

// Format: sk_live_ + [a-zA-Z0-9]{10,99} (gitleaks: stripe-access-token)
const PLACEHOLDER_VALUE = "sk_live_CoffeeSafeLocalCoffeeSafeLocalCoff";

const READ_METHODS = new Set(["get", "head"]);
const WRITE_METHODS = new Set(["post", "put", "patch", "delete"]);

// These aliases come from the official Stripe permissions reference rows where
// the published permission stem differs from the OpenAPI schema x-resourceId.
// Do not add path guesses here; keep unmapped operations visible unless an
// official permission row explicitly names the same resource family.
const RESOURCE_ID_PERMISSION_STEM_ALIASES = new Map<string, string>([
  ["apps.secret", "secret"],
  ["billing_portal.configuration", "customer_portal"],
  ["billing_portal.session", "customer_portal"],
  ["login_link", "edit_link"],
  ["payment_link", "payment_links"],
  ["payment_record", "payment_records"],
  ["price", "plan"],
  ["refund", "charge"],
  ["reporting.report_run", "report_runs_and_report_types"],
  ["reporting.report_type", "report_runs_and_report_types"],
  ["tax.calculation", "tax_calculations_and_transactions"],
  ["tax.registration", "tax_settings"],
  ["tax.settings", "tax_settings"],
  ["tax.transaction", "tax_calculations_and_transactions"],
  ["test_helpers.test_clock", "billing_clock"],
  ["terminal.configuration", "terminal_configuration"],
  ["terminal.location", "terminal_location"],
  ["terminal.reader", "terminal_reader"],
  ["topup", "top_up"],
  ["webhook_endpoint", "webhook"],
]);

const ACCESS_RESOURCE_ID_PERMISSION_STEM_ALIASES = new Map<
  string,
  Partial<Record<"read" | "write", string>>
>([["account", { read: "connected_account" }]]);

const REPRESENTATIVE_RULES: ReadonlyArray<{
  permission: string;
  rule: string;
}> = [
  { permission: "customer_read", rule: "GET /v1/customers" },
  { permission: "customer_write", rule: "POST /v1/customers" },
  {
    permission: "payment_intent_read",
    rule: "GET /v1/payment_intents/{intent}",
  },
  {
    permission: "payment_intent_write",
    rule: "POST /v1/payment_intents/{intent}/confirm",
  },
  {
    permission: "checkout_session_read",
    rule: "GET /v1/checkout/sessions/{session}",
  },
  {
    permission: "checkout_session_write",
    rule: "POST /v1/checkout/sessions",
  },
];

const REPRESENTATIVE_ALIAS_RULES: ReadonlyArray<{
  permission: string;
  rule: string;
}> = [
  { permission: "charge_read", rule: "GET /v1/refunds" },
  { permission: "charge_write", rule: "POST /v1/refunds" },
  {
    permission: "customer_portal_read",
    rule: "GET /v1/billing_portal/configurations",
  },
  {
    permission: "payment_records_write",
    rule: "POST /v1/payment_records/report_payment",
  },
  {
    permission: "terminal_reader_read",
    rule: "GET /v1/terminal/readers/{reader}",
  },
];

interface StripeOpenApiSpec {
  info?: {
    version?: string;
  };
  paths?: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, Record<string, unknown>>;
  };
}

interface StripePermissionDefinition {
  name: string;
  description: string;
}

interface StripePermissionRow {
  product: string;
  resource: string;
  permissions: string[];
  description: string;
  apiDocUrls: string[];
}

interface BuildStats {
  specVersion: string;
  totalOperations: number;
  mappedOperations: number;
  docsMappedOperations: number;
  unmappedOperations: number;
  ambiguousOperations: number;
  permissionCount: number;
}

interface BuildResult {
  permissions: PermissionGroup[];
  stats: BuildStats;
  unmappedRules: string[];
  ambiguousRules: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordProp(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function arrayProp(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function stringProp(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function schemaNameFromRef(ref: string): string | null {
  const prefix = "#/components/schemas/";
  if (!ref.startsWith(prefix)) return null;
  return ref.slice(prefix.length);
}

function schemaResourceId(
  spec: StripeOpenApiSpec,
  schemaName: string,
): string | null {
  const schema = spec.components?.schemas?.[schemaName];
  if (!schema) return null;
  return stringProp(schema, "x-resourceId");
}

function addResourceIdsFromSchema(
  spec: StripeOpenApiSpec,
  schema: Record<string, unknown>,
  resourceIds: Set<string>,
  seenRefs: Set<string>,
): void {
  const directResourceId = stringProp(schema, "x-resourceId");
  if (directResourceId) {
    resourceIds.add(directResourceId);
  }

  const ref = stringProp(schema, "$ref");
  if (ref) {
    const schemaName = schemaNameFromRef(ref);
    if (!schemaName || seenRefs.has(schemaName)) return;
    seenRefs.add(schemaName);
    const resourceId = schemaResourceId(spec, schemaName);
    if (resourceId) {
      resourceIds.add(resourceId);
    }
    const referencedSchema = spec.components?.schemas?.[schemaName];
    if (referencedSchema) {
      addResourceIdsFromSchema(spec, referencedSchema, resourceIds, seenRefs);
    }
    return;
  }

  for (const key of ["anyOf", "oneOf", "allOf"]) {
    for (const item of arrayProp(schema, key)) {
      if (isRecord(item)) {
        addResourceIdsFromSchema(spec, item, resourceIds, seenRefs);
      }
    }
  }

  const properties = recordProp(schema, "properties");
  const data = properties ? recordProp(properties, "data") : null;
  const items = data ? recordProp(data, "items") : null;
  if (items) {
    addResourceIdsFromSchema(spec, items, resourceIds, seenRefs);
  }
}

function successJsonSchema(operation: Record<string, unknown>) {
  const responses = recordProp(operation, "responses");
  if (!responses) return null;

  const successCodes = Object.keys(responses)
    .filter((code) => {
      return code.startsWith("2");
    })
    .sort();

  for (const code of successCodes) {
    const response = recordProp(responses, code);
    const content = response ? recordProp(response, "content") : null;
    const json = content ? recordProp(content, "application/json") : null;
    const schema = json ? recordProp(json, "schema") : null;
    if (schema) return schema;
  }

  return null;
}

function resourceIdsForOperation(
  spec: StripeOpenApiSpec,
  operation: Record<string, unknown>,
): string[] {
  const schema = successJsonSchema(operation);
  if (!schema) return [];

  const resourceIds = new Set<string>();
  addResourceIdsFromSchema(spec, schema, resourceIds, new Set());
  return [...resourceIds].sort();
}

function permissionNameForResource(
  resourceId: string,
  access: "read" | "write",
): string {
  return `${resourceId.replace(/\./g, "_")}_${access}`;
}

function aliasStemForResource(
  resourceId: string,
  access: "read" | "write",
): string | null {
  const accessAlias =
    ACCESS_RESOURCE_ID_PERMISSION_STEM_ALIASES.get(resourceId)?.[access];
  if (accessAlias) return accessAlias;

  return RESOURCE_ID_PERMISSION_STEM_ALIASES.get(resourceId) ?? null;
}

function pushPermissionNameForStem(
  names: Set<string>,
  stem: string,
  access: "read" | "write",
  permissionDefinitions: Map<string, StripePermissionDefinition>,
): void {
  const permissionName = permissionNameForResource(stem, access);
  if (permissionDefinitions.has(permissionName)) {
    names.add(permissionName);
  }
}

function permissionNamesForResource(
  resourceId: string,
  access: "read" | "write",
  permissionDefinitions: Map<string, StripePermissionDefinition>,
): string[] {
  const names = new Set<string>();

  pushPermissionNameForStem(names, resourceId, access, permissionDefinitions);
  const aliasStem = aliasStemForResource(resourceId, access);
  if (aliasStem) {
    pushPermissionNameForStem(names, aliasStem, access, permissionDefinitions);
  }

  if (access === "write" && resourceId.startsWith("deleted_")) {
    const underlyingResourceId = resourceId.slice("deleted_".length);
    pushPermissionNameForStem(
      names,
      underlyingResourceId,
      access,
      permissionDefinitions,
    );
    const underlyingAliasStem = aliasStemForResource(
      underlyingResourceId,
      access,
    );
    if (underlyingAliasStem) {
      pushPermissionNameForStem(
        names,
        underlyingAliasStem,
        access,
        permissionDefinitions,
      );
    }
  }

  return [...names].sort();
}

function chooseSingleResourcePermission(
  resourceId: string,
  access: "read" | "write",
  permissionDefinitions: Map<string, StripePermissionDefinition>,
): string | null {
  const names = permissionNamesForResource(
    resourceId,
    access,
    permissionDefinitions,
  );
  if (names.length > 1) {
    throw new Error(
      `Stripe resource "${resourceId}" maps to multiple ${access} permissions: ${names.join(", ")}`,
    );
  }
  return names[0] ?? null;
}

function resourceIdWithoutDeletedPrefix(resourceId: string): string {
  return resourceId.startsWith("deleted_")
    ? resourceId.slice("deleted_".length)
    : resourceId;
}

function chooseAmbiguousResourcePermission(
  resourceIds: string[],
  access: "read" | "write",
  permissionDefinitions: Map<string, StripePermissionDefinition>,
): string | null {
  const candidatesByResource = resourceIds.map((resourceId) => {
    return permissionNamesForResource(
      resourceId,
      access,
      permissionDefinitions,
    );
  });
  const candidates = new Set(candidatesByResource.flat());
  if (candidates.size !== 1) return null;

  const allResourcesKnown = candidatesByResource.every((names) => {
    return names.length === 1;
  });
  if (allResourcesKnown) return [...candidates][0]!;

  const normalizedResourceIds = new Set(
    resourceIds.map(resourceIdWithoutDeletedPrefix),
  );
  if (normalizedResourceIds.size === 1) {
    return [...candidates][0]!;
  }

  return null;
}

function cleanPermissionName(value: string): string {
  return value.replace(/`/g, "").trim();
}

function parseApiDocUrls(description: string): string[] {
  return stripeApiDocUrlsFromDescription(description);
}

function parsePermissionRows(markdown: string): StripePermissionRow[] {
  const rows: StripePermissionRow[] = [];
  let inObjectTable = false;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "Product | Resource | Permissions | Description") {
      inObjectTable = true;
      continue;
    }
    if (inObjectTable && line.startsWith("## Event permissions")) {
      break;
    }
    if (!inObjectTable || line === "" || line.startsWith("--- |")) {
      continue;
    }

    const parts = line.split(" | ");
    if (parts.length < 4) continue;

    const product = parts[0]?.trim();
    const resource = parts[1]?.trim();
    const permissionColumn = parts[2]?.trim();
    const description = parts[3]?.trim();
    if (!product || !resource || !permissionColumn || !description) continue;

    const permissions = permissionColumn
      .split(",")
      .map(cleanPermissionName)
      .filter((permission) => {
        return permission !== "";
      });
    if (permissions.length === 0) continue;

    rows.push({
      product,
      resource,
      permissions,
      description,
      apiDocUrls: parseApiDocUrls(description),
    });
  }

  if (rows.length === 0) {
    throw new Error("No Stripe permission rows found in permissions reference");
  }

  return rows;
}

function buildPermissionDefinitions(
  rows: StripePermissionRow[],
): Map<string, StripePermissionDefinition> {
  const definitions = new Map<string, StripePermissionDefinition>();

  for (const row of rows) {
    const description = `${row.product} - ${row.resource}`;
    for (const name of row.permissions) {
      if (!name) continue;

      const existing = definitions.get(name);
      if (existing && existing.description !== description) {
        throw new Error(
          `Duplicate Stripe permission "${name}" has conflicting descriptions`,
        );
      }
      definitions.set(name, { name, description });
    }
  }

  if (definitions.size === 0) {
    throw new Error("No Stripe permissions found in permissions reference");
  }

  return definitions;
}

function accessForMethod(methodLower: string): "read" | "write" | null {
  if (READ_METHODS.has(methodLower)) return "read";
  if (WRITE_METHODS.has(methodLower)) return "write";
  return null;
}

function accessForMethodUpper(methodUpper: string): "read" | "write" | null {
  return accessForMethod(methodUpper.toLowerCase());
}

function ruleShape(methodUpper: string, apiPath: string): string {
  const normalizedPath = apiPath
    .replace(/:[A-Za-z0-9_]+/g, "{}")
    .replace(/\{[^}]+\}/g, "{}");
  return `${methodUpper} ${normalizedPath}`;
}

function buildOpenApiRuleByShape(spec: StripeOpenApiSpec): Map<string, string> {
  if (!spec.paths) {
    throw new Error("Stripe OpenAPI spec has no 'paths'");
  }

  const rules = new Map<string, string>();
  for (const [apiPath, methods] of Object.entries(spec.paths)) {
    for (const methodLower of Object.keys(methods)) {
      if (!ALL_METHODS.has(methodLower)) continue;

      const methodUpper = methodLower.toUpperCase();
      const shape = ruleShape(methodUpper, apiPath);
      const existing = rules.get(shape);
      if (existing) {
        throw new Error(
          `Stripe OpenAPI has duplicate endpoint shape "${shape}": ${existing}, ${methodUpper} ${apiPath}`,
        );
      }
      rules.set(shape, `${methodUpper} ${apiPath}`);
    }
  }
  return rules;
}

function permissionForEndpointMethod(
  row: StripePermissionRow,
  methodUpper: string,
): string | null {
  const access = accessForMethodUpper(methodUpper);
  if (!access) return null;

  return (
    row.permissions.find((permission) => {
      return permission.endsWith(`_${access}`);
    }) ?? null
  );
}

function parseApiDocEndpointRules(markdown: string): Array<{
  methodUpper: string;
  apiPath: string;
}> {
  return [...markdown.matchAll(/- \[([A-Z]+) ([^\]]+)\]\(/g)].map((match) => {
    return {
      methodUpper: match[1]!,
      apiPath: match[2]!,
    };
  });
}

async function buildApiDocsPermissionMap(
  spec: StripeOpenApiSpec,
  rows: StripePermissionRow[],
): Promise<{
  permissionsByRule: Map<string, string>;
  conflictRules: string[];
}> {
  const openApiRuleByShape = buildOpenApiRuleByShape(spec);
  const permissionsByRule = new Map<string, string>();
  const conflictRules = new Set<string>();
  const apiDocUrls = new Map<string, StripePermissionRow[]>();

  for (const row of rows) {
    for (const url of row.apiDocUrls) {
      const linkRows = apiDocUrls.get(url) ?? [];
      linkRows.push(row);
      apiDocUrls.set(url, linkRows);
    }
  }

  console.error(`  ${apiDocUrls.size} official Stripe API docs pages loaded`);
  for (const [url, linkRows] of apiDocUrls) {
    const res = await fetchSpec(url, `Stripe API docs page ${url}`);
    const endpointRules = parseApiDocEndpointRules(await res.text());

    for (const endpoint of endpointRules) {
      const openApiRule = openApiRuleByShape.get(
        ruleShape(endpoint.methodUpper, endpoint.apiPath),
      );
      if (!openApiRule) continue;

      for (const row of linkRows) {
        const permission = permissionForEndpointMethod(
          row,
          endpoint.methodUpper,
        );
        if (!permission) continue;

        const existing = permissionsByRule.get(openApiRule);
        if (existing && existing !== permission) {
          conflictRules.add(openApiRule);
          continue;
        }
        permissionsByRule.set(openApiRule, permission);
      }
    }
  }

  for (const rule of conflictRules) {
    permissionsByRule.delete(rule);
  }

  return {
    permissionsByRule,
    conflictRules: [...conflictRules].sort(),
  };
}

function validateRepresentativeRules(
  permissions: PermissionGroup[],
  permissionDefinitions: Map<string, StripePermissionDefinition>,
): void {
  const byName = new Map(
    permissions.map((permission) => {
      return [permission.name, permission];
    }),
  );

  for (const { permission, rule } of REPRESENTATIVE_RULES) {
    if (!permissionDefinitions.has(permission)) {
      throw new Error(
        `Representative Stripe permission "${permission}" is missing from official permissions reference`,
      );
    }
    const rules = byName.get(permission)?.rules ?? [];
    if (!rules.includes(rule)) {
      throw new Error(
        `Representative Stripe rule "${rule}" is missing from permission "${permission}"`,
      );
    }
  }

  for (const { permission, rule } of REPRESENTATIVE_ALIAS_RULES) {
    if (!permissionDefinitions.has(permission)) {
      throw new Error(
        `Representative Stripe alias permission "${permission}" is missing from official permissions reference`,
      );
    }
    const rules = byName.get(permission)?.rules ?? [];
    if (!rules.includes(rule)) {
      throw new Error(
        `Representative Stripe alias rule "${rule}" is missing from permission "${permission}"`,
      );
    }
  }
}

function buildGroups(
  spec: StripeOpenApiSpec,
  permissionDefinitions: Map<string, StripePermissionDefinition>,
  apiDocsPermissionsByRule: Map<string, string>,
): BuildResult {
  if (!spec.paths) {
    throw new Error("Stripe OpenAPI spec has no 'paths'");
  }

  const groups = new Map<string, Set<string>>();
  const unmappedRules: string[] = [];
  const ambiguousRules: string[] = [];
  let totalOperations = 0;
  let mappedOperations = 0;
  let docsMappedOperations = 0;

  for (const [apiPath, methods] of Object.entries(spec.paths)) {
    for (const [methodLower, op] of Object.entries(methods)) {
      if (typeof op !== "object" || op === null) continue;
      if (!ALL_METHODS.has(methodLower)) {
        if (
          OPENAPI_PATH_KEYS.has(methodLower) ||
          methodLower.startsWith("x-")
        ) {
          continue;
        }
        throw new Error(`Unexpected key '${methodLower}' on ${apiPath}`);
      }

      const access = accessForMethod(methodLower);
      if (!access) continue;

      totalOperations += 1;
      const rule = `${methodLower.toUpperCase()} ${apiPath}`;
      const operation = op as Record<string, unknown>;
      const resourceIds = resourceIdsForOperation(spec, operation);

      const resourcePermissionName =
        resourceIds.length === 1
          ? chooseSingleResourcePermission(
              resourceIds[0]!,
              access,
              permissionDefinitions,
            )
          : chooseAmbiguousResourcePermission(
              resourceIds,
              access,
              permissionDefinitions,
            );
      const docsPermissionName = apiDocsPermissionsByRule.get(rule) ?? null;
      if (
        resourcePermissionName &&
        docsPermissionName &&
        resourcePermissionName !== docsPermissionName
      ) {
        throw new Error(
          `Stripe permission sources disagree for "${rule}": OpenAPI resourceId maps to "${resourcePermissionName}", API docs map to "${docsPermissionName}"`,
        );
      }

      const permissionName = resourcePermissionName ?? docsPermissionName;
      if (!permissionName) {
        if (resourceIds.length > 1) {
          ambiguousRules.push(rule);
        } else {
          unmappedRules.push(rule);
        }
        continue;
      }

      let ruleSet = groups.get(permissionName);
      if (!ruleSet) {
        ruleSet = new Set();
        groups.set(permissionName, ruleSet);
      }
      ruleSet.add(rule);
      mappedOperations += 1;
      if (!resourcePermissionName && docsPermissionName) {
        docsMappedOperations += 1;
      }
    }
  }

  const permissions = [...groups.entries()]
    .filter(([, ruleSet]) => ruleSet.size > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, ruleSet]) => ({
      name,
      description: permissionDefinitions.get(name)?.description,
      rules: sanitizeAndSortRules([...ruleSet]),
    }));

  validateRepresentativeRules(permissions, permissionDefinitions);

  const stats: BuildStats = {
    specVersion: spec.info?.version ?? "unknown",
    totalOperations,
    mappedOperations,
    docsMappedOperations,
    unmappedOperations: totalOperations - mappedOperations,
    ambiguousOperations: ambiguousRules.length,
    permissionCount: permissions.length,
  };

  return {
    permissions,
    stats,
    unmappedRules,
    ambiguousRules,
  };
}

function renderStats(stats: BuildStats): string[] {
  return [
    "",
    "export const stripeGenerationStats = {",
    `  specVersion: "${escapeString(stats.specVersion)}",`,
    `  totalOperations: ${stats.totalOperations},`,
    `  mappedOperations: ${stats.mappedOperations},`,
    `  docsMappedOperations: ${stats.docsMappedOperations},`,
    `  unmappedOperations: ${stats.unmappedOperations},`,
    `  ambiguousOperations: ${stats.ambiguousOperations},`,
    `  permissionCount: ${stats.permissionCount},`,
    "} as const;",
    "",
  ];
}

function generateTypeScript(
  permissions: PermissionGroup[],
  stats: BuildStats,
): string {
  const lines: string[] = [
    "// Auto-generated from official Stripe API data.",
    `// OpenAPI source: ${STRIPE_OPENAPI_URL}`,
    `// Permissions source: ${STRIPE_PERMISSIONS_URL}`,
    "// Update sources: cd turbo && pnpm -F @vm0/firewalls-generator update-specs:stripe",
    "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:stripe",
    "//",
    "// DO NOT EDIT THIS FILE MANUALLY.",
    "",
    'import type { FirewallConfig } from "../firewall-types";',
    "",
    "export const stripeFirewall = {",
    '  name: "stripe",',
    '  description: "Stripe API",',
    "  placeholders: {",
    `    STRIPE_TOKEN: "${PLACEHOLDER_VALUE}",`,
    "  },",
    "  apis: [",
    "    {",
    '      base: "https://api.stripe.com",',
    "      auth: {",
    "        headers: {",
    '          Authorization: "Bearer ${{ secrets.STRIPE_TOKEN }}",',
    "        },",
    "      },",
    "      permissions: [",
  ];

  lines.push(...renderPermissions(permissions));

  lines.push("      ],");
  lines.push("    },");
  lines.push("  ],");
  lines.push("} as const satisfies FirewallConfig;");
  lines.push(...renderStats(stats));

  return lines.join("\n");
}

function logUnmapped(kind: string, rules: string[]): void {
  if (rules.length === 0) return;
  console.error(`  ${rules.length} ${kind} Stripe operations:`);
  for (const rule of rules.slice(0, 20)) {
    console.error(`    ${rule}`);
  }
  if (rules.length > 20) {
    console.error(`    ... ${rules.length - 20} more`);
  }
}

export async function generate(): Promise<void> {
  console.error("Generating Stripe firewall config...");

  const openapiRes = await fetchSpec(STRIPE_OPENAPI_URL, "Stripe OpenAPI spec");
  const spec = (await openapiRes.json()) as StripeOpenApiSpec;
  console.error(`  Spec version: ${spec.info?.version ?? "unknown"}`);

  const permissionsRes = await fetchSpec(
    STRIPE_PERMISSIONS_URL,
    "Stripe permissions reference",
  );
  const permissionRows = parsePermissionRows(await permissionsRes.text());
  const permissionDefinitions = buildPermissionDefinitions(permissionRows);
  console.error(
    `  ${permissionDefinitions.size} official permission names loaded`,
  );
  const { permissionsByRule, conflictRules } = await buildApiDocsPermissionMap(
    spec,
    permissionRows,
  );
  if (conflictRules.length > 0) {
    logUnmapped("conflicting API docs", conflictRules);
  }

  const { permissions, stats, unmappedRules, ambiguousRules } = buildGroups(
    spec,
    permissionDefinitions,
    permissionsByRule,
  );
  logUnmapped("unmapped", unmappedRules);
  logUnmapped("ambiguous", ambiguousRules);

  const ts = generateTypeScript(permissions, stats);

  logStats(permissions);
  writeOutput("stripe", ts, import.meta.dirname);
}
