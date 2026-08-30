import fs from "node:fs/promises";
import path from "node:path";
import {
  DESKTOP_PRODUCTS,
  type DesktopProduct,
} from "@okouai/api-contracts/contracts/client-headers";
import { MODEL_PROVIDER_WRITE_INPUT_TYPE_IDS } from "@okouai/api-contracts/contracts/model-provider-types";
import {
  PUBLIC_BRANDS,
  type PublicBrand,
} from "@okouai/api-contracts/contracts/public-brand";
import { DEFAULT_PROFILE } from "@okouai/api-contracts/contracts/runners";
import type { Client } from "pg";
import {
  LEGACY_DATABASE_IDENTITY_KINDS,
  LEGACY_DATABASE_IDENTITY_SOURCES,
  type LegacyDatabaseIdentityKind,
  type LegacyDatabaseIdentityManifestEntry,
  type LegacyDatabaseIdentitySource,
} from "./legacy-database-identity-manifest";

const LEGACY_DATABASE_TOKEN_PATTERN =
  /(?:^|[^A-Za-z0-9])(?:zero|vm0)(?=$|[^A-Za-z0-9])/iu;
const POSTGRES_IDENTIFIER_MAX_BYTES = 63;
const NON_MEASURABLE_METADATA_PATTERN =
  /\b(?:eventually|fixme|forever|later|n\/?a|none|tbd|todo|unknown)\b|for compatibility|to be determined/iu;
const MEASURABLE_METADATA_PATTERN =
  /\b(?:all|both|every|exact|no|only|zero)\b|\b\d+(?:-day|-hour)\b|\b\d+\s+(?:consecutive\s+)?(?:days?|hours?)\b/iu;
const WILDCARD_PATTERN = /[*?]/u;

export const REPLAYED_CATALOG_RELATION_CONSTRAINT_TYPES = [
  "c",
  "f",
  "p",
  "u",
  "x",
] as const;

export interface DiscoveredLegacyDatabaseIdentity {
  readonly evidence: readonly string[];
  readonly key: string;
  readonly kind: LegacyDatabaseIdentityKind;
  readonly members: readonly string[];
  readonly sources: readonly LegacyDatabaseIdentitySource[];
}

export interface LegacyCatalogCandidate {
  readonly evidence: string;
  readonly key: string;
  readonly kind: LegacyDatabaseIdentityKind;
  readonly matchTexts: readonly string[];
  readonly members: readonly string[];
}

export interface LatestSnapshotDiscovery {
  readonly identities: readonly DiscoveredLegacyDatabaseIdentity[];
  readonly migrationIndex: number;
  readonly migrationTag: string;
  readonly snapshotFile: string;
  readonly snapshot: unknown;
}

interface SnapshotColumnSurface {
  readonly columnName: string;
  readonly schemaName: string;
  readonly tableName: string;
}

interface MutableDiscoveredIdentity {
  readonly evidence: Set<string>;
  readonly key: string;
  readonly kind: LegacyDatabaseIdentityKind;
  readonly members: Set<string>;
  readonly sources: Set<LegacyDatabaseIdentitySource>;
}

interface CatalogRelationRow {
  readonly definition: string | null;
  readonly objectName: string;
  readonly relationKind: string;
  readonly schemaName: string;
}

interface CatalogColumnRow {
  readonly columnName: string;
  readonly defaultExpression: string | null;
  readonly schemaName: string;
  readonly tableName: string;
}

interface CatalogIndexRow {
  readonly definition: string;
  readonly indexName: string;
  readonly schemaName: string;
}

interface CatalogConstraintRow {
  readonly constraintName: string;
  readonly constraintType: string;
  readonly definition: string;
  readonly schemaName: string;
  readonly tableName: string;
}

interface CatalogTriggerRow {
  readonly definition: string;
  readonly schemaName: string;
  readonly tableName: string;
  readonly triggerName: string;
}

interface CatalogFunctionRow {
  readonly definition: string;
  readonly functionName: string;
  readonly identityArguments: string;
  readonly schemaName: string;
}

interface CatalogRuleRow {
  readonly definition: string;
  readonly relationKind: string;
  readonly relationName: string;
  readonly ruleName: string;
  readonly schemaName: string;
}

interface CatalogViewDependencyRow {
  readonly sourceRelationName: string;
  readonly sourceSchemaName: string;
  readonly viewName: string;
  readonly viewSchemaName: string;
}

interface CatalogEnumRow {
  readonly enumName: string;
  readonly enumValue: string;
  readonly schemaName: string;
}

interface CatalogPolicyRow {
  readonly policyName: string;
  readonly policyUsing: string | null;
  readonly policyWithCheck: string | null;
  readonly schemaName: string;
  readonly tableName: string;
}

export function hasLegacyDatabaseToken(value: string): boolean {
  return LEGACY_DATABASE_TOKEN_PATTERN.test(value);
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => {
    return left.localeCompare(right);
  });
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  return value === undefined ? {} : asRecord(value, label);
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function postgresIdentifier(identifier: string): string {
  const bytes = Buffer.from(identifier);
  if (bytes.length <= POSTGRES_IDENTIFIER_MAX_BYTES) return identifier;

  let byteLength = POSTGRES_IDENTIFIER_MAX_BYTES;
  while (
    byteLength > 0 &&
    (bytes[byteLength] ?? 0) >= 0x80 &&
    (bytes[byteLength] ?? 0) < 0xc0
  ) {
    byteLength -= 1;
  }
  return bytes.subarray(0, byteLength).toString("utf8");
}

function snapshotObjectName(
  objectKey: string,
  objectData: Record<string, unknown>,
): string {
  return (
    optionalString(objectData.name, `${objectKey}.name`) ??
    objectKey.slice(objectKey.lastIndexOf(".") + 1)
  );
}

function snapshotSchemaName(
  objectKey: string,
  objectData: Record<string, unknown>,
): string {
  const explicitSchema = optionalString(
    objectData.schema,
    `${objectKey}.schema`,
  );
  if (explicitSchema) return explicitSchema;
  const separator = objectKey.lastIndexOf(".");
  return separator === -1 ? "public" : objectKey.slice(0, separator);
}

function candidate(
  key: string,
  kind: LegacyDatabaseIdentityKind,
  member: string,
  matchTexts: readonly string[],
  evidence: string,
): LegacyCatalogCandidate {
  return { evidence, key, kind, matchTexts, members: [member] };
}

function catalogRuleCandidates(
  rules: readonly CatalogRuleRow[],
): LegacyCatalogCandidate[] {
  return rules.map((rule) => {
    const isView = rule.relationKind === "v" || rule.relationKind === "m";
    const relationMember = `${rule.schemaName}.${rule.relationName}`;
    const member = isView
      ? relationMember
      : `${relationMember}.rule:${rule.ruleName}`;
    return candidate(
      `${isView ? "view" : "trigger"}:${member}`,
      isView ? "view" : "trigger",
      member,
      [rule.ruleName, rule.definition],
      `catalog:rule:${relationMember}.${rule.ruleName}`,
    );
  });
}

function discoverCandidates(
  candidates: readonly LegacyCatalogCandidate[],
  source: LegacyDatabaseIdentitySource,
): readonly DiscoveredLegacyDatabaseIdentity[] {
  const discovered = new Map<string, MutableDiscoveredIdentity>();

  for (const object of candidates) {
    if (!object.matchTexts.some(hasLegacyDatabaseToken)) continue;

    const existing = discovered.get(object.key);
    if (existing && existing.kind !== object.kind) {
      throw new Error(
        `Legacy identity ${object.key} was discovered with both ${existing.kind} and ${object.kind} kinds`,
      );
    }
    const normalized =
      existing ??
      ({
        evidence: new Set<string>(),
        key: object.key,
        kind: object.kind,
        members: new Set<string>(),
        sources: new Set<LegacyDatabaseIdentitySource>(),
      } satisfies MutableDiscoveredIdentity);
    normalized.evidence.add(object.evidence);
    normalized.sources.add(source);
    for (const member of object.members) normalized.members.add(member);
    discovered.set(object.key, normalized);
  }

  return [...discovered.values()]
    .map((object) => {
      return {
        evidence: sortedUnique(object.evidence),
        key: object.key,
        kind: object.kind,
        members: sortedUnique(object.members),
        sources: sortedUnique(object.sources) as LegacyDatabaseIdentitySource[],
      };
    })
    .sort((left, right) => {
      return left.key.localeCompare(right.key);
    });
}

function snapshotTables(snapshot: unknown): Record<string, unknown> {
  const root = asRecord(snapshot, "Drizzle snapshot");
  return optionalRecord(root.tables, "Drizzle snapshot tables");
}

function snapshotColumnSurfaces(snapshot: unknown): SnapshotColumnSurface[] {
  const surfaces: SnapshotColumnSurface[] = [];
  for (const [tableKey, rawTable] of Object.entries(snapshotTables(snapshot))) {
    const table = asRecord(rawTable, `Drizzle snapshot table ${tableKey}`);
    const tableName = snapshotObjectName(tableKey, table);
    const schemaName = snapshotSchemaName(tableKey, table);
    const columns = optionalRecord(
      table.columns,
      `Drizzle snapshot table ${tableKey} columns`,
    );
    for (const [columnKey, rawColumn] of Object.entries(columns)) {
      const column = asRecord(
        rawColumn,
        `Drizzle snapshot column ${tableKey}.${columnKey}`,
      );
      surfaces.push({
        columnName:
          optionalString(
            column.name,
            `Drizzle snapshot column ${tableKey}.${columnKey}.name`,
          ) ?? columnKey,
        schemaName,
        tableName,
      });
    }
  }
  return surfaces;
}

function snapshotColumnCandidates(args: {
  readonly relationMember: string;
  readonly table: Record<string, unknown>;
  readonly tableKey: string;
}): LegacyCatalogCandidate[] {
  const candidates: LegacyCatalogCandidate[] = [];
  const columns = optionalRecord(
    args.table.columns,
    `Drizzle snapshot table ${args.tableKey} columns`,
  );
  for (const [columnKey, rawColumn] of Object.entries(columns)) {
    const column = asRecord(
      rawColumn,
      `Drizzle snapshot column ${args.tableKey}.${columnKey}`,
    );
    const columnName =
      optionalString(
        column.name,
        `Drizzle snapshot column ${args.tableKey}.${columnKey}.name`,
      ) ?? columnKey;
    const columnMember = `${args.relationMember}.${columnName}`;
    candidates.push(
      candidate(
        `column:${columnMember}`,
        "column",
        columnMember,
        [columnName],
        `snapshot:column:${columnMember}`,
      ),
    );
    if (column.default !== undefined) {
      candidates.push(
        candidate(
          `default:${columnMember}`,
          "default",
          columnMember,
          [String(column.default)],
          `snapshot:default:${columnMember}`,
        ),
      );
    }
  }
  return candidates;
}

function snapshotIndexCandidates(args: {
  readonly schemaName: string;
  readonly table: Record<string, unknown>;
  readonly tableKey: string;
}): LegacyCatalogCandidate[] {
  const indexes = optionalRecord(
    args.table.indexes,
    `Drizzle snapshot table ${args.tableKey} indexes`,
  );
  return Object.entries(indexes).map(([indexKey, rawIndex]) => {
    const index = asRecord(
      rawIndex,
      `Drizzle snapshot index ${args.tableKey}.${indexKey}`,
    );
    const declaredName =
      optionalString(
        index.name,
        `Drizzle snapshot index ${args.tableKey}.${indexKey}.name`,
      ) ?? indexKey;
    const indexName = postgresIdentifier(declaredName);
    const member = `${args.schemaName}.${indexName}`;
    return candidate(
      `index:${member}`,
      "index",
      member,
      [declaredName, JSON.stringify(index)],
      `snapshot:index:${member}`,
    );
  });
}

function snapshotConstraintCandidates(args: {
  readonly relationMember: string;
  readonly table: Record<string, unknown>;
  readonly tableKey: string;
}): LegacyCatalogCandidate[] {
  const candidates: LegacyCatalogCandidate[] = [];
  for (const collectionName of ["foreignKeys", "checkConstraints"] as const) {
    const constraints = optionalRecord(
      args.table[collectionName],
      `Drizzle snapshot table ${args.tableKey} ${collectionName}`,
    );
    for (const [constraintKey, rawConstraint] of Object.entries(constraints)) {
      const constraint = asRecord(
        rawConstraint,
        `Drizzle snapshot constraint ${args.tableKey}.${constraintKey}`,
      );
      const declaredName =
        optionalString(
          constraint.name,
          `Drizzle snapshot constraint ${args.tableKey}.${constraintKey}.name`,
        ) ?? constraintKey;
      const constraintName = postgresIdentifier(declaredName);
      const member = `${args.relationMember}.${constraintName}`;
      candidates.push(
        candidate(
          `constraint:${member}`,
          "constraint",
          member,
          [declaredName, JSON.stringify(constraint)],
          `snapshot:constraint:${member}`,
        ),
      );
    }
  }
  return candidates;
}

function snapshotPolicyCandidates(args: {
  readonly relationMember: string;
  readonly table: Record<string, unknown>;
  readonly tableKey: string;
}): LegacyCatalogCandidate[] {
  const policies = optionalRecord(
    args.table.policies,
    `Drizzle snapshot table ${args.tableKey} policies`,
  );
  return Object.entries(policies).map(([policyKey, rawPolicy]) => {
    const policy = asRecord(
      rawPolicy,
      `Drizzle snapshot policy ${args.tableKey}.${policyKey}`,
    );
    const declaredName =
      optionalString(
        policy.name,
        `Drizzle snapshot policy ${args.tableKey}.${policyKey}.name`,
      ) ?? policyKey;
    const policyName = postgresIdentifier(declaredName);
    const member = `${args.relationMember}.policy:${policyName}`;
    return candidate(
      `constraint:${member}`,
      "constraint",
      member,
      [declaredName, JSON.stringify(policy)],
      `snapshot:policy:${member}`,
    );
  });
}

function snapshotTableCandidates(
  tableKey: string,
  rawTable: unknown,
): LegacyCatalogCandidate[] {
  const table = asRecord(rawTable, `Drizzle snapshot table ${tableKey}`);
  const tableName = snapshotObjectName(tableKey, table);
  const schemaName = snapshotSchemaName(tableKey, table);
  const relationMember = `${schemaName}.${tableName}`;
  return [
    candidate(
      `relation:${relationMember}`,
      "relation",
      relationMember,
      [tableName],
      `snapshot:relation:${relationMember}`,
    ),
    ...snapshotColumnCandidates({ relationMember, table, tableKey }),
    ...snapshotIndexCandidates({ schemaName, table, tableKey }),
    ...snapshotConstraintCandidates({ relationMember, table, tableKey }),
    ...snapshotPolicyCandidates({ relationMember, table, tableKey }),
  ];
}

function snapshotViewCandidates(
  root: Record<string, unknown>,
): LegacyCatalogCandidate[] {
  const views = optionalRecord(root.views, "Drizzle snapshot views");
  return Object.entries(views).map(([viewKey, rawView]) => {
    const view = asRecord(rawView, `Drizzle snapshot view ${viewKey}`);
    const viewName = snapshotObjectName(viewKey, view);
    const schemaName = snapshotSchemaName(viewKey, view);
    const member = `${schemaName}.${viewName}`;
    return candidate(
      `view:${member}`,
      "view",
      member,
      [viewName, JSON.stringify(view)],
      `snapshot:view:${member}`,
    );
  });
}

function snapshotEnumCandidates(
  root: Record<string, unknown>,
): LegacyCatalogCandidate[] {
  const candidates: LegacyCatalogCandidate[] = [];
  const enums = optionalRecord(root.enums, "Drizzle snapshot enums");
  for (const [enumKey, rawEnum] of Object.entries(enums)) {
    const enumObject = asRecord(rawEnum, `Drizzle snapshot enum ${enumKey}`);
    const enumName = snapshotObjectName(enumKey, enumObject);
    const schemaName = snapshotSchemaName(enumKey, enumObject);
    const enumMember = `${schemaName}.${enumName}`;
    candidates.push(
      candidate(
        `enum-discriminator-value:${enumMember}`,
        "enum-discriminator-value",
        enumMember,
        [enumName],
        `snapshot:enum:${enumMember}`,
      ),
    );
    const values = enumObject.values;
    if (values === undefined) continue;
    if (
      !Array.isArray(values) ||
      values.some((value) => {
        return typeof value !== "string";
      })
    ) {
      throw new Error(
        `Drizzle snapshot enum ${enumKey}.values must be strings`,
      );
    }
    for (const value of values) {
      const member = `${enumMember} = '${value}'`;
      candidates.push(
        candidate(
          `enum-discriminator-value:${member}`,
          "enum-discriminator-value",
          member,
          [value],
          `snapshot:enum-value:${member}`,
        ),
      );
    }
  }
  return candidates;
}

export function discoverLegacySnapshotIdentities(
  snapshot: unknown,
): readonly DiscoveredLegacyDatabaseIdentity[] {
  const root = asRecord(snapshot, "Drizzle snapshot");
  const candidates = [
    ...Object.entries(snapshotTables(snapshot)).flatMap(
      ([tableKey, rawTable]) => {
        return snapshotTableCandidates(tableKey, rawTable);
      },
    ),
    ...snapshotViewCandidates(root),
    ...snapshotEnumCandidates(root),
  ];
  return discoverCandidates(candidates, "snapshot");
}

export async function discoverLatestLegacySnapshotIdentities(
  migrationsDirectory: string,
): Promise<LatestSnapshotDiscovery> {
  const journalFile = path.join(migrationsDirectory, "meta/_journal.json");
  const journal = asRecord(
    JSON.parse(await fs.readFile(journalFile, "utf8")) as unknown,
    "Drizzle journal",
  );
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error("Drizzle journal must contain at least one entry");
  }
  const latest = asRecord(
    journal.entries[journal.entries.length - 1],
    "latest Drizzle journal entry",
  );
  if (!Number.isInteger(latest.idx) || typeof latest.idx !== "number") {
    throw new Error("latest Drizzle journal entry idx must be an integer");
  }
  if (typeof latest.tag !== "string" || latest.tag.length === 0) {
    throw new Error("latest Drizzle journal entry tag must be a string");
  }

  const snapshotFile = path.join(
    migrationsDirectory,
    "meta",
    `${String(latest.idx).padStart(4, "0")}_snapshot.json`,
  );
  const snapshot: unknown = JSON.parse(await fs.readFile(snapshotFile, "utf8"));
  return {
    identities: discoverLegacySnapshotIdentities(snapshot),
    migrationIndex: latest.idx,
    migrationTag: latest.tag,
    snapshot,
    snapshotFile,
  };
}

export function discoverLegacyCatalogIdentities(
  candidates: readonly LegacyCatalogCandidate[],
): readonly DiscoveredLegacyDatabaseIdentity[] {
  return discoverCandidates(candidates, "catalog");
}

async function catalogRelationCandidates(
  client: Client,
): Promise<LegacyCatalogCandidate[]> {
  const relations = await client.query<CatalogRelationRow>(`
    SELECT
      namespace."nspname" AS "schemaName",
      relation."relname" AS "objectName",
      relation."relkind"::text AS "relationKind",
      CASE
        WHEN relation."relkind" IN ('v', 'm')
          THEN pg_catalog.pg_get_viewdef(relation."oid", true)
        ELSE NULL
      END AS "definition"
    FROM pg_catalog."pg_class" AS relation
    INNER JOIN pg_catalog."pg_namespace" AS namespace
      ON namespace."oid" = relation."relnamespace"
    WHERE namespace."nspname" = current_schema()
      AND relation."relkind" IN ('r', 'p', 'v', 'm')
    ORDER BY namespace."nspname", relation."relname"
  `);
  return relations.rows.map((relation) => {
    const kind =
      relation.relationKind === "v" || relation.relationKind === "m"
        ? "view"
        : "relation";
    const member = `${relation.schemaName}.${relation.objectName}`;
    return candidate(
      `${kind}:${member}`,
      kind,
      member,
      [relation.objectName, relation.definition ?? ""],
      `catalog:relation:${relation.relationKind}:${member}`,
    );
  });
}

async function catalogColumnCandidates(
  client: Client,
): Promise<LegacyCatalogCandidate[]> {
  const columns = await client.query<CatalogColumnRow>(`
    SELECT
      namespace."nspname" AS "schemaName",
      relation."relname" AS "tableName",
      attribute."attname" AS "columnName",
      pg_catalog.pg_get_expr(
        attribute_default."adbin",
        attribute_default."adrelid"
      ) AS "defaultExpression"
    FROM pg_catalog."pg_attribute" AS attribute
    INNER JOIN pg_catalog."pg_class" AS relation
      ON relation."oid" = attribute."attrelid"
    INNER JOIN pg_catalog."pg_namespace" AS namespace
      ON namespace."oid" = relation."relnamespace"
    LEFT JOIN pg_catalog."pg_attrdef" AS attribute_default
      ON attribute_default."adrelid" = attribute."attrelid"
      AND attribute_default."adnum" = attribute."attnum"
    WHERE namespace."nspname" = current_schema()
      AND relation."relkind" IN ('r', 'p')
      AND attribute."attnum" > 0
      AND NOT attribute."attisdropped"
    ORDER BY namespace."nspname", relation."relname", attribute."attnum"
  `);
  return columns.rows.flatMap((column) => {
    const member = `${column.schemaName}.${column.tableName}.${column.columnName}`;
    const discovered = [
      candidate(
        `column:${member}`,
        "column",
        member,
        [column.columnName],
        `catalog:column:${member}`,
      ),
    ];
    if (column.defaultExpression !== null) {
      discovered.push(
        candidate(
          `default:${member}`,
          "default",
          member,
          [column.defaultExpression],
          `catalog:default:${member}`,
        ),
      );
    }
    return discovered;
  });
}

async function catalogIndexCandidates(
  client: Client,
): Promise<LegacyCatalogCandidate[]> {
  const indexes = await client.query<CatalogIndexRow>(`
    SELECT
      namespace."nspname" AS "schemaName",
      index_relation."relname" AS "indexName",
      pg_catalog.pg_get_indexdef(index_relation."oid") AS "definition"
    FROM pg_catalog."pg_index" AS index_state
    INNER JOIN pg_catalog."pg_class" AS index_relation
      ON index_relation."oid" = index_state."indexrelid"
    INNER JOIN pg_catalog."pg_class" AS table_relation
      ON table_relation."oid" = index_state."indrelid"
    INNER JOIN pg_catalog."pg_namespace" AS namespace
      ON namespace."oid" = table_relation."relnamespace"
    WHERE namespace."nspname" = current_schema()
      AND NOT index_state."indisprimary"
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog."pg_constraint" AS constraint_row
        WHERE constraint_row."conindid" = index_state."indexrelid"
      )
    ORDER BY namespace."nspname", index_relation."relname"
  `);
  return indexes.rows.map((index) => {
    const member = `${index.schemaName}.${index.indexName}`;
    return candidate(
      `index:${member}`,
      "index",
      member,
      [index.indexName, index.definition],
      `catalog:index:${member}`,
    );
  });
}

async function catalogConstraintCandidates(
  client: Client,
): Promise<LegacyCatalogCandidate[]> {
  const constraintTypes = REPLAYED_CATALOG_RELATION_CONSTRAINT_TYPES.map(
    (constraintType) => {
      return `'${constraintType}'`;
    },
  ).join(", ");
  const constraints = await client.query<CatalogConstraintRow>(`
    SELECT
      namespace."nspname" AS "schemaName",
      relation."relname" AS "tableName",
      constraint_row."conname" AS "constraintName",
      constraint_row."contype"::text AS "constraintType",
      pg_catalog.pg_get_constraintdef(constraint_row."oid", true)
        AS "definition"
    FROM pg_catalog."pg_constraint" AS constraint_row
    INNER JOIN pg_catalog."pg_class" AS relation
      ON relation."oid" = constraint_row."conrelid"
    INNER JOIN pg_catalog."pg_namespace" AS namespace
      ON namespace."oid" = relation."relnamespace"
    WHERE namespace."nspname" = current_schema()
      AND constraint_row."contype" IN (${constraintTypes})
    ORDER BY namespace."nspname", relation."relname", constraint_row."conname"
  `);
  return constraints.rows.map((constraint) => {
    const member = `${constraint.schemaName}.${constraint.tableName}.${constraint.constraintName}`;
    return candidate(
      `constraint:${member}`,
      "constraint",
      member,
      [constraint.constraintName, constraint.definition],
      `catalog:constraint:${constraint.constraintType}:${member}`,
    );
  });
}

async function catalogTriggerCandidates(
  client: Client,
): Promise<LegacyCatalogCandidate[]> {
  const triggers = await client.query<CatalogTriggerRow>(`
    SELECT
      namespace."nspname" AS "schemaName",
      relation."relname" AS "tableName",
      trigger_row."tgname" AS "triggerName",
      pg_catalog.pg_get_triggerdef(trigger_row."oid") AS "definition"
    FROM pg_catalog."pg_trigger" AS trigger_row
    INNER JOIN pg_catalog."pg_class" AS relation
      ON relation."oid" = trigger_row."tgrelid"
    INNER JOIN pg_catalog."pg_namespace" AS namespace
      ON namespace."oid" = relation."relnamespace"
    WHERE namespace."nspname" = current_schema()
      AND NOT trigger_row."tgisinternal"
    ORDER BY namespace."nspname", relation."relname", trigger_row."tgname"
  `);
  return triggers.rows.map((trigger) => {
    const member = `${trigger.schemaName}.${trigger.tableName}.${trigger.triggerName}`;
    return candidate(
      `trigger:${member}`,
      "trigger",
      member,
      [trigger.triggerName, trigger.definition],
      `catalog:trigger:${member}`,
    );
  });
}

async function catalogFunctionCandidates(
  client: Client,
): Promise<LegacyCatalogCandidate[]> {
  const functions = await client.query<CatalogFunctionRow>(`
    SELECT
      namespace."nspname" AS "schemaName",
      function_row."proname" AS "functionName",
      pg_catalog.pg_get_function_identity_arguments(function_row."oid")
        AS "identityArguments",
      pg_catalog.pg_get_functiondef(function_row."oid") AS "definition"
    FROM pg_catalog."pg_proc" AS function_row
    INNER JOIN pg_catalog."pg_namespace" AS namespace
      ON namespace."oid" = function_row."pronamespace"
    WHERE namespace."nspname" = current_schema()
      AND function_row."prokind" IN ('f', 'p')
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog."pg_depend" AS dependency
        WHERE dependency."classid" = 'pg_catalog.pg_proc'::regclass
          AND dependency."objid" = function_row."oid"
          AND dependency."refclassid" = 'pg_catalog.pg_extension'::regclass
          AND dependency."deptype" = 'e'
      )
    ORDER BY
      namespace."nspname",
      function_row."proname",
      pg_catalog.pg_get_function_identity_arguments(function_row."oid")
  `);
  return functions.rows.map((catalogFunction) => {
    const member = `${catalogFunction.schemaName}.${catalogFunction.functionName}(${catalogFunction.identityArguments})`;
    return candidate(
      `function:${member}`,
      "function",
      member,
      [catalogFunction.functionName, catalogFunction.definition],
      `catalog:function:${member}`,
    );
  });
}

async function replayedRuleCandidates(
  client: Client,
): Promise<LegacyCatalogCandidate[]> {
  const rules = await client.query<CatalogRuleRow>(`
    SELECT
      namespace."nspname" AS "schemaName",
      relation."relname" AS "relationName",
      relation."relkind"::text AS "relationKind",
      rule_row."rulename" AS "ruleName",
      pg_catalog.pg_get_ruledef(rule_row."oid", true) AS "definition"
    FROM pg_catalog."pg_rewrite" AS rule_row
    INNER JOIN pg_catalog."pg_class" AS relation
      ON relation."oid" = rule_row."ev_class"
    INNER JOIN pg_catalog."pg_namespace" AS namespace
      ON namespace."oid" = relation."relnamespace"
    WHERE namespace."nspname" = current_schema()
    ORDER BY namespace."nspname", relation."relname", rule_row."rulename"
  `);
  return catalogRuleCandidates(rules.rows);
}

async function catalogViewDependencyCandidates(
  client: Client,
): Promise<LegacyCatalogCandidate[]> {
  const dependencies = await client.query<CatalogViewDependencyRow>(`
    SELECT DISTINCT
      view_namespace."nspname" AS "viewSchemaName",
      view_relation."relname" AS "viewName",
      source_namespace."nspname" AS "sourceSchemaName",
      source_relation."relname" AS "sourceRelationName"
    FROM pg_catalog."pg_rewrite" AS rule_row
    INNER JOIN pg_catalog."pg_class" AS view_relation
      ON view_relation."oid" = rule_row."ev_class"
    INNER JOIN pg_catalog."pg_namespace" AS view_namespace
      ON view_namespace."oid" = view_relation."relnamespace"
    INNER JOIN pg_catalog."pg_depend" AS dependency
      ON dependency."classid" = 'pg_catalog.pg_rewrite'::regclass
      AND dependency."objid" = rule_row."oid"
    INNER JOIN pg_catalog."pg_class" AS source_relation
      ON source_relation."oid" = dependency."refobjid"
    INNER JOIN pg_catalog."pg_namespace" AS source_namespace
      ON source_namespace."oid" = source_relation."relnamespace"
    WHERE view_namespace."nspname" = current_schema()
      AND source_namespace."nspname" = current_schema()
      AND view_relation."relkind" IN ('v', 'm')
      AND source_relation."oid" <> view_relation."oid"
    ORDER BY
      view_namespace."nspname",
      view_relation."relname",
      source_namespace."nspname",
      source_relation."relname"
  `);
  return dependencies.rows.map((dependency) => {
    const member = `${dependency.viewSchemaName}.${dependency.viewName}`;
    const source = `${dependency.sourceSchemaName}.${dependency.sourceRelationName}`;
    return candidate(
      `view:${member}`,
      "view",
      member,
      [dependency.viewName, dependency.sourceRelationName],
      `catalog:dependency:${member}->${source}`,
    );
  });
}

async function catalogEnumCandidates(
  client: Client,
): Promise<LegacyCatalogCandidate[]> {
  const enums = await client.query<CatalogEnumRow>(`
    SELECT
      namespace."nspname" AS "schemaName",
      enum_type."typname" AS "enumName",
      enum_value."enumlabel" AS "enumValue"
    FROM pg_catalog."pg_enum" AS enum_value
    INNER JOIN pg_catalog."pg_type" AS enum_type
      ON enum_type."oid" = enum_value."enumtypid"
    INNER JOIN pg_catalog."pg_namespace" AS namespace
      ON namespace."oid" = enum_type."typnamespace"
    WHERE namespace."nspname" = current_schema()
    ORDER BY namespace."nspname", enum_type."typname", enum_value."enumsortorder"
  `);
  return enums.rows.map((enumValue) => {
    const enumMember = `${enumValue.schemaName}.${enumValue.enumName}`;
    const member = `${enumMember} = '${enumValue.enumValue}'`;
    return candidate(
      `enum-discriminator-value:${member}`,
      "enum-discriminator-value",
      member,
      [enumValue.enumName, enumValue.enumValue],
      `catalog:enum-value:${member}`,
    );
  });
}

async function catalogPolicyCandidates(
  client: Client,
): Promise<LegacyCatalogCandidate[]> {
  const policies = await client.query<CatalogPolicyRow>(`
    SELECT
      namespace."nspname" AS "schemaName",
      relation."relname" AS "tableName",
      policy."polname" AS "policyName",
      pg_catalog.pg_get_expr(policy."polqual", policy."polrelid")
        AS "policyUsing",
      pg_catalog.pg_get_expr(policy."polwithcheck", policy."polrelid")
        AS "policyWithCheck"
    FROM pg_catalog."pg_policy" AS policy
    INNER JOIN pg_catalog."pg_class" AS relation
      ON relation."oid" = policy."polrelid"
    INNER JOIN pg_catalog."pg_namespace" AS namespace
      ON namespace."oid" = relation."relnamespace"
    WHERE namespace."nspname" = current_schema()
    ORDER BY namespace."nspname", relation."relname", policy."polname"
  `);
  return policies.rows.map((policy) => {
    const member = `${policy.schemaName}.${policy.tableName}.policy:${policy.policyName}`;
    return candidate(
      `constraint:${member}`,
      "constraint",
      member,
      [
        policy.policyName,
        policy.policyUsing ?? "",
        policy.policyWithCheck ?? "",
      ],
      `catalog:policy:${member}`,
    );
  });
}

export async function discoverReplayedCatalogLegacyIdentities(
  client: Client,
): Promise<readonly DiscoveredLegacyDatabaseIdentity[]> {
  await client.query(`SET search_path TO public, pg_catalog`);
  const candidates: LegacyCatalogCandidate[] = [];
  candidates.push(...(await catalogRelationCandidates(client)));

  candidates.push(...(await catalogColumnCandidates(client)));

  candidates.push(...(await catalogIndexCandidates(client)));
  candidates.push(...(await catalogConstraintCandidates(client)));

  candidates.push(...(await catalogTriggerCandidates(client)));
  candidates.push(...(await catalogFunctionCandidates(client)));

  candidates.push(...(await replayedRuleCandidates(client)));
  candidates.push(...(await catalogViewDependencyCandidates(client)));

  candidates.push(...(await catalogEnumCandidates(client)));
  candidates.push(...(await catalogPolicyCandidates(client)));

  return discoverLegacyCatalogIdentities(candidates);
}

function semanticMember(surface: SnapshotColumnSurface, value: string): string {
  return `${surface.schemaName}.${surface.tableName}.${surface.columnName} = '${value}'`;
}

function contractIncludes<T extends string>(
  values: readonly T[],
  expected: T,
): boolean {
  return values.some((value) => {
    return value === expected;
  });
}

export function discoverPersistedSemanticLegacyIdentities(
  snapshot: unknown,
): readonly DiscoveredLegacyDatabaseIdentity[] {
  const surfaces = snapshotColumnSurfaces(snapshot);
  const candidates: LegacyCatalogCandidate[] = [];

  const legacyProvider =
    "vm0" satisfies (typeof MODEL_PROVIDER_WRITE_INPUT_TYPE_IDS)[number];
  if (!contractIncludes(MODEL_PROVIDER_WRITE_INPUT_TYPE_IDS, legacyProvider)) {
    throw new Error(
      "Model provider write-input contract no longer accepts vm0",
    );
  }
  const providerMembers = surfaces
    .filter((surface) => {
      return (
        surface.columnName === "model_provider" ||
        surface.columnName === "model_provider_type" ||
        surface.columnName === "default_provider_type" ||
        (surface.tableName === "model_providers" &&
          surface.columnName === "type")
      );
    })
    .map((surface) => {
      return semanticMember(surface, legacyProvider);
    });
  candidates.push({
    evidence: "semantic-contract:model-provider",
    key: "enum-discriminator-value:contract.model-provider = 'vm0'",
    kind: "enum-discriminator-value",
    matchTexts: [legacyProvider],
    members: providerMembers,
  });

  const legacyPublicBrand = "vm0" satisfies PublicBrand;
  if (!contractIncludes(PUBLIC_BRANDS, legacyPublicBrand)) {
    throw new Error("Public brand contract no longer declares vm0");
  }
  const publicBrandMembers = surfaces
    .filter((surface) => {
      return surface.columnName === "public_brand";
    })
    .map((surface) => {
      return semanticMember(surface, legacyPublicBrand);
    });
  candidates.push({
    evidence: "semantic-contract:public-brand",
    key: "enum-discriminator-value:contract.public-brand = 'vm0'",
    kind: "enum-discriminator-value",
    matchTexts: [legacyPublicBrand],
    members: publicBrandMembers,
  });

  const legacyDesktopProduct = "zero" satisfies DesktopProduct;
  if (!contractIncludes(DESKTOP_PRODUCTS, legacyDesktopProduct)) {
    throw new Error("Desktop product contract no longer declares zero");
  }
  const desktopMembers = surfaces
    .filter((surface) => {
      return surface.columnName === "client_product";
    })
    .map((surface) => {
      return semanticMember(surface, legacyDesktopProduct);
    });
  candidates.push({
    evidence: "semantic-contract:desktop-product",
    key: "enum-discriminator-value:contract.desktop-product = 'zero'",
    kind: "enum-discriminator-value",
    matchTexts: [legacyDesktopProduct],
    members: desktopMembers,
  });

  if (DEFAULT_PROFILE !== "vm0/default") {
    throw new Error("Runner profile contract no longer declares vm0/default");
  }
  const runnerProfileMembers = surfaces
    .filter((surface) => {
      return (
        surface.tableName === "runner_job_queue" &&
        surface.columnName === "profile"
      );
    })
    .map((surface) => {
      return semanticMember(surface, DEFAULT_PROFILE);
    });
  candidates.push({
    evidence: "semantic-contract:runner-profile",
    key: "enum-discriminator-value:contract.runner-profile = 'vm0/default'",
    kind: "enum-discriminator-value",
    matchTexts: [DEFAULT_PROFILE],
    members: runnerProfileMembers,
  });

  for (const object of candidates) {
    if (object.members.length === 0) {
      throw new Error(`${object.key} has no current schema members`);
    }
  }
  return discoverCandidates(candidates, "semantic-contract");
}

function sameStrings(left: Iterable<string>, right: Iterable<string>): boolean {
  const normalizedLeft = sortedUnique(left);
  const normalizedRight = sortedUnique(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => {
      return value === normalizedRight[index];
    })
  );
}

function validateMetadataText(
  entry: LegacyDatabaseIdentityManifestEntry,
  field: "drainEvidence" | "reason" | "removalGate" | "writerStopCondition",
  errors: string[],
): void {
  const value = entry[field].trim();
  if (value.length === 0) {
    errors.push(`${entry.key}: ${field} is empty`);
    return;
  }
  if (NON_MEASURABLE_METADATA_PATTERN.test(value)) {
    errors.push(`${entry.key}: ${field} contains non-measurable language`);
  }
  if (field !== "reason" && !MEASURABLE_METADATA_PATTERN.test(value)) {
    errors.push(`${entry.key}: ${field} has no measurable condition`);
  }
}

function validateManifestMembers(
  entry: LegacyDatabaseIdentityManifestEntry,
  semanticMembers: Map<string, string>,
  errors: string[],
): void {
  if (entry.members.length === 0) {
    errors.push(`${entry.key}: members must not be empty`);
  }
  const memberSet = new Set<string>();
  for (const member of entry.members) {
    if (member.trim().length === 0) {
      errors.push(`${entry.key}: member must not be empty`);
    }
    if (WILDCARD_PATTERN.test(member)) {
      errors.push(`${entry.key}: wildcard member ${member} is forbidden`);
    }
    if (memberSet.has(member)) {
      errors.push(`${entry.key}: duplicate member ${member}`);
    }
    memberSet.add(member);

    if (entry.kind !== "enum-discriminator-value") continue;
    const existingFamily = semanticMembers.get(member);
    if (existingFamily && existingFamily !== entry.key) {
      errors.push(
        `${member}: overlapping semantic families ${existingFamily} and ${entry.key}`,
      );
    } else {
      semanticMembers.set(member, entry.key);
    }
  }
}

function validateManifestSources(
  entry: LegacyDatabaseIdentityManifestEntry,
  errors: string[],
): void {
  if (entry.sources.length === 0) {
    errors.push(`${entry.key}: sources must not be empty`);
  }
  const sourceSet = new Set<LegacyDatabaseIdentitySource>();
  for (const source of entry.sources) {
    if (!LEGACY_DATABASE_IDENTITY_SOURCES.includes(source)) {
      errors.push(`${entry.key}: unsupported source ${source}`);
    }
    if (sourceSet.has(source)) {
      errors.push(`${entry.key}: duplicate source ${source}`);
    }
    sourceSet.add(source);
  }
}

export function assertLegacyDatabaseIdentityManifest(
  manifest: readonly LegacyDatabaseIdentityManifestEntry[],
): void {
  const errors: string[] = [];
  const keys = new Map<string, number>();
  const semanticMembers = new Map<string, string>();

  for (const [index, entry] of manifest.entries()) {
    const previousIndex = keys.get(entry.key);
    if (previousIndex !== undefined) {
      errors.push(
        `${entry.key}: duplicate key at entries ${previousIndex} and ${index}`,
      );
    } else {
      keys.set(entry.key, index);
    }

    if (entry.key.trim().length === 0) errors.push(`entry ${index}: empty key`);
    if (WILDCARD_PATTERN.test(entry.key)) {
      errors.push(`${entry.key}: wildcard keys are forbidden`);
    }
    if (!entry.key.startsWith(`${entry.kind}:`)) {
      errors.push(`${entry.key}: key prefix does not match kind ${entry.kind}`);
    }
    if (
      entry.classification !== "migrate" &&
      entry.classification !== "retain"
    ) {
      errors.push(`${entry.key}: unsupported classification`);
    }
    if (!LEGACY_DATABASE_IDENTITY_KINDS.includes(entry.kind)) {
      errors.push(`${entry.key}: unsupported kind ${entry.kind}`);
    }
    if (!/^#\d+$/u.test(entry.ownerIssue)) {
      errors.push(`${entry.key}: ownerIssue must be an exact GitHub issue`);
    }
    validateManifestMembers(entry, semanticMembers, errors);
    validateManifestSources(entry, errors);

    validateMetadataText(entry, "reason", errors);
    validateMetadataText(entry, "writerStopCondition", errors);
    validateMetadataText(entry, "drainEvidence", errors);
    validateMetadataText(entry, "removalGate", errors);
  }

  if (errors.length > 0) {
    throw new Error(
      [
        "Legacy database identity manifest is invalid",
        ...errors.map((error) => {
          return `- ${error}`;
        }),
      ].join("\n"),
    );
  }
}

function normalizeDiscoveredIdentities(
  identities: readonly DiscoveredLegacyDatabaseIdentity[],
): readonly DiscoveredLegacyDatabaseIdentity[] {
  const normalized = new Map<string, MutableDiscoveredIdentity>();
  for (const identity of identities) {
    const existing = normalized.get(identity.key);
    if (existing) {
      if (existing.kind !== identity.kind) {
        throw new Error(
          `Discovered identity ${identity.key} has conflicting kinds ${existing.kind} and ${identity.kind}`,
        );
      }
      if (!sameStrings(existing.members, identity.members)) {
        throw new Error(
          `Discovered identity ${identity.key} has conflicting members across sources`,
        );
      }
      for (const source of identity.sources) existing.sources.add(source);
      for (const evidence of identity.evidence) existing.evidence.add(evidence);
      continue;
    }
    normalized.set(identity.key, {
      evidence: new Set(identity.evidence),
      key: identity.key,
      kind: identity.kind,
      members: new Set(identity.members),
      sources: new Set(identity.sources),
    });
  }

  return [...normalized.values()]
    .map((identity) => {
      return {
        evidence: sortedUnique(identity.evidence),
        key: identity.key,
        kind: identity.kind,
        members: sortedUnique(identity.members),
        sources: sortedUnique(
          identity.sources,
        ) as LegacyDatabaseIdentitySource[],
      };
    })
    .sort((left, right) => {
      return left.key.localeCompare(right.key);
    });
}

function inventoryMismatchError(sections: readonly string[]): Error {
  return new Error(
    ["Active legacy database identity inventory mismatch", ...sections].join(
      "\n",
    ),
  );
}

export function assertLegacyDatabaseIdentitySourceInventory(args: {
  readonly discovered: readonly DiscoveredLegacyDatabaseIdentity[];
  readonly manifest: readonly LegacyDatabaseIdentityManifestEntry[];
  readonly source: LegacyDatabaseIdentitySource;
}): void {
  assertLegacyDatabaseIdentityManifest(args.manifest);
  const expected = new Map(
    args.manifest
      .filter((entry) => {
        return entry.sources.includes(args.source);
      })
      .map((entry) => {
        return [entry.key, entry] as const;
      }),
  );
  const actual = new Map(
    normalizeDiscoveredIdentities(args.discovered)
      .filter((entry) => {
        return entry.sources.includes(args.source);
      })
      .map((entry) => {
        return [entry.key, entry] as const;
      }),
  );
  const unclassified = [...actual.keys()].filter((key) => {
    return !expected.has(key);
  });
  const stale = [...expected.keys()].filter((key) => {
    return !actual.has(key);
  });
  const disagreements = [...expected.entries()].flatMap(([key, entry]) => {
    const discovered = actual.get(key);
    if (!discovered) return [];
    const problems: string[] = [];
    if (entry.kind !== discovered.kind) {
      problems.push(
        `${key}: expected ${entry.kind}, discovered ${discovered.kind}`,
      );
    }
    if (!sameStrings(entry.members, discovered.members)) {
      problems.push(
        `${key}: expected members [${sortedUnique(entry.members).join(", ")}], discovered [${sortedUnique(discovered.members).join(", ")}]`,
      );
    }
    return problems;
  });

  const sections: string[] = [];
  if (unclassified.length > 0) {
    sections.push(
      `Unclassified ${args.source} identities:\n${unclassified
        .sort()
        .map((key) => {
          return `- ${key}`;
        })
        .join("\n")}`,
    );
  }
  if (stale.length > 0) {
    sections.push(
      `Manifest entries missing from ${args.source}:\n${stale
        .sort()
        .map((key) => {
          return `- ${key}`;
        })
        .join("\n")}`,
    );
  }
  if (disagreements.length > 0) {
    sections.push(
      `Member or kind disagreements:\n${disagreements
        .map((value) => {
          return `- ${value}`;
        })
        .join("\n")}`,
    );
  }
  if (sections.length > 0) throw inventoryMismatchError(sections);
}

export function assertLegacyDatabaseIdentityInventory(args: {
  readonly discovered: readonly DiscoveredLegacyDatabaseIdentity[];
  readonly manifest: readonly LegacyDatabaseIdentityManifestEntry[];
}): void {
  assertLegacyDatabaseIdentityManifest(args.manifest);
  const expected = new Map(
    args.manifest.map((entry) => {
      return [entry.key, entry] as const;
    }),
  );
  const normalized = normalizeDiscoveredIdentities(args.discovered);
  const actual = new Map(
    normalized.map((entry) => {
      return [entry.key, entry] as const;
    }),
  );

  const unclassified = [...actual.keys()].filter((key) => {
    return !expected.has(key);
  });
  const stale = [...expected.keys()].filter((key) => {
    return !actual.has(key);
  });
  const disagreements = [...expected.entries()].flatMap(([key, entry]) => {
    const discovered = actual.get(key);
    if (!discovered) return [];
    const problems: string[] = [];
    if (entry.kind !== discovered.kind) {
      problems.push(
        `${key}: expected ${entry.kind}, discovered ${discovered.kind}`,
      );
    }
    if (!sameStrings(entry.members, discovered.members)) {
      problems.push(
        `${key}: expected members [${sortedUnique(entry.members).join(", ")}], discovered [${sortedUnique(discovered.members).join(", ")}]`,
      );
    }
    if (!sameStrings(entry.sources, discovered.sources)) {
      problems.push(
        `${key}: expected sources [${sortedUnique(entry.sources).join(", ")}], discovered [${sortedUnique(discovered.sources).join(", ")}]`,
      );
    }
    if (
      entry.kind === "view" &&
      entry.sources.length === 1 &&
      entry.sources[0] === "catalog"
    ) {
      for (const requiredEvidence of [
        "catalog:relation:",
        "catalog:rule:",
        "catalog:dependency:",
      ]) {
        if (
          !discovered.evidence.some((evidence) => {
            return evidence.startsWith(requiredEvidence);
          })
        ) {
          problems.push(`${key}: missing ${requiredEvidence} replay evidence`);
        }
      }
    }
    return problems;
  });

  const sections: string[] = [];
  if (unclassified.length > 0) {
    sections.push(
      `Unclassified identities:\n${unclassified
        .sort()
        .map((key) => {
          return `- ${key}`;
        })
        .join("\n")}`,
    );
  }
  if (stale.length > 0) {
    sections.push(
      `Manifest entries missing from current state:\n${stale
        .sort()
        .map((key) => {
          return `- ${key}`;
        })
        .join("\n")}`,
    );
  }
  if (disagreements.length > 0) {
    sections.push(
      `Source, member, or kind disagreements:\n${disagreements
        .map((value) => {
          return `- ${value}`;
        })
        .join("\n")}`,
    );
  }
  if (sections.length > 0) throw inventoryMismatchError(sections);
}

export function countLegacyIdentitiesByKind(
  identities: readonly DiscoveredLegacyDatabaseIdentity[],
): Readonly<Record<LegacyDatabaseIdentityKind, number>> {
  const counts = Object.fromEntries(
    LEGACY_DATABASE_IDENTITY_KINDS.map((kind) => {
      return [kind, 0];
    }),
  ) as Record<LegacyDatabaseIdentityKind, number>;
  for (const identity of normalizeDiscoveredIdentities(identities)) {
    counts[identity.kind] += 1;
  }
  return counts;
}
