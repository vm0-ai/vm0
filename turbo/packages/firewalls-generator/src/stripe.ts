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
 * generator only maps operations whose response schema has an unambiguous
 * x-resourceId that normalizes to an official permission name.
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

const OPENAPI_URL =
  "https://raw.githubusercontent.com/stripe/openapi/master/latest/openapi.spec3.json";
const PERMISSIONS_URL =
  "https://docs.stripe.com/stripe-apps/reference/permissions.md";

// Format: sk_live_ + [a-zA-Z0-9]{10,99} (gitleaks: stripe-access-token)
const PLACEHOLDER_VALUE = "sk_live_CoffeeSafeLocalCoffeeSafeLocalCoff";

const READ_METHODS = new Set(["get", "head"]);
const WRITE_METHODS = new Set(["post", "put", "patch", "delete"]);

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

interface BuildStats {
  specVersion: string;
  totalOperations: number;
  mappedOperations: number;
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

function cleanPermissionName(value: string): string {
  return value.replace(/`/g, "").trim();
}

function parsePermissionDefinitions(
  markdown: string,
): Map<string, StripePermissionDefinition> {
  const definitions = new Map<string, StripePermissionDefinition>();
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
    if (!product || !resource || !permissionColumn) continue;

    const description = `${product} - ${resource}`;
    for (const rawPermission of permissionColumn.split(",")) {
      const name = cleanPermissionName(rawPermission);
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
}

function buildGroups(
  spec: StripeOpenApiSpec,
  permissionDefinitions: Map<string, StripePermissionDefinition>,
): BuildResult {
  if (!spec.paths) {
    throw new Error("Stripe OpenAPI spec has no 'paths'");
  }

  const groups = new Map<string, Set<string>>();
  const unmappedRules: string[] = [];
  const ambiguousRules: string[] = [];
  let totalOperations = 0;
  let mappedOperations = 0;

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

      if (resourceIds.length !== 1) {
        if (resourceIds.length > 1) {
          ambiguousRules.push(rule);
        } else {
          unmappedRules.push(rule);
        }
        continue;
      }

      const permissionName = permissionNameForResource(resourceIds[0]!, access);
      if (!permissionDefinitions.has(permissionName)) {
        unmappedRules.push(rule);
        continue;
      }

      let ruleSet = groups.get(permissionName);
      if (!ruleSet) {
        ruleSet = new Set();
        groups.set(permissionName, ruleSet);
      }
      ruleSet.add(rule);
      mappedOperations += 1;
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
    unmappedOperations: totalOperations - mappedOperations,
    ambiguousOperations: ambiguousRules.length,
    permissionCount: permissions.length,
  };

  return { permissions, stats, unmappedRules, ambiguousRules };
}

function renderStats(stats: BuildStats): string[] {
  return [
    "",
    "export const stripeGenerationStats = {",
    `  specVersion: "${escapeString(stats.specVersion)}",`,
    `  totalOperations: ${stats.totalOperations},`,
    `  mappedOperations: ${stats.mappedOperations},`,
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
    `// OpenAPI source: ${OPENAPI_URL}`,
    `// Permissions source: ${PERMISSIONS_URL}`,
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

  const openapiRes = await fetchSpec(OPENAPI_URL, "Stripe OpenAPI spec");
  const spec = (await openapiRes.json()) as StripeOpenApiSpec;
  console.error(`  Spec version: ${spec.info?.version ?? "unknown"}`);

  const permissionsRes = await fetchSpec(
    PERMISSIONS_URL,
    "Stripe permissions reference",
  );
  const permissionDefinitions = parsePermissionDefinitions(
    await permissionsRes.text(),
  );
  console.error(
    `  ${permissionDefinitions.size} official permission names loaded`,
  );

  const { permissions, stats, unmappedRules, ambiguousRules } = buildGroups(
    spec,
    permissionDefinitions,
  );
  logUnmapped("unmapped", unmappedRules);
  logUnmapped("ambiguous", ambiguousRules);

  const ts = generateTypeScript(permissions, stats);

  logStats(permissions);
  writeOutput("stripe", ts, import.meta.dirname);
}
