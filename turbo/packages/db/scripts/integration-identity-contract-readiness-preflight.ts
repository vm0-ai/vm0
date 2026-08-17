#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type QueryResultRow } from "pg";
import {
  CATALOG_DEPENDENCY_KINDS,
  CATALOG_DEPENDENCY_QUERY,
  EXPECTED_CATALOG_DEPENDENCIES,
  INTEGRATION_IDENTITY_TABLES,
  normalizeCatalogDependencyRow,
  type CatalogDependencyKind,
  type CatalogDependencySourceRow,
  type IntegrationIdentityTableName,
} from "./integration-identity-contract-readiness-preflight-manifest";

export const PREFLIGHT_SCHEMA_VERSION =
  "vm0.integration-identity-contract-readiness-preflight.v1";

const MINIMUM_SERVER_VERSION = 170000;
const DEFAULT_LOCK_TIMEOUT_MS = 1000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const SET_FINGERPRINT_DOMAIN =
  "vm0:integration-identity-contract-readiness-preflight:set:v1";

const SANITIZED_PROBE_FAILURE_GATES = [
  "probe.aggregate_contract",
  "probe.cancelled",
  "probe.capability_gate",
  "probe.configuration",
  "probe.database_connection",
  "probe.database_resolution",
  "probe.inventory",
  "probe.lock_timeout",
  "probe.output_contract",
  "probe.row_inventory",
  "probe.statement_timeout",
  "probe.transaction_cleanup",
  "probe.transaction_start",
  "probe.unexpected",
] as const;

type SanitizedFailureGate = (typeof SANITIZED_PROBE_FAILURE_GATES)[number];

const ROW_INVENTORY_QUERY = INTEGRATION_IDENTITY_TABLES.map(({ tableName }) => {
  return `
SELECT
  '${tableName}'::text AS "tableName",
  COUNT(*)::text AS "totalCount",
  COUNT(*) FILTER (
    WHERE "user_id" IS NULL
      OR "vm0_user_id" IS NULL
      OR "user_id" IS DISTINCT FROM "vm0_user_id"
  )::text AS "invalidCount"
FROM "public"."${tableName}"`;
}).join("\nUNION ALL\n");

interface SetFingerprint {
  readonly count: number;
  readonly digest: string;
}

interface DependencyComparison {
  readonly classification: "exact" | "drift";
  readonly expected: SetFingerprint;
  readonly observed: SetFingerprint;
}

export interface PreflightCapabilities {
  readonly serverVersionClassification: "supported";
  readonly transactionReadOnly: true;
  readonly isolationLevel: "repeatable read";
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

interface RowAggregate {
  readonly total_count: number;
  readonly invalid_count: number;
}

export interface PreflightInventory {
  readonly rows: readonly RowInventoryRow[];
  readonly catalogDependencies: readonly CatalogDependencySourceRow[];
}

export interface SuccessfulPreflightResult {
  readonly schemaVersion: typeof PREFLIGHT_SCHEMA_VERSION;
  readonly status: "passed" | "failed";
  readonly failureGates: readonly string[];
  readonly capabilities: PreflightCapabilities;
  readonly rows: {
    readonly total_count: number;
    readonly invalid_count: number;
    readonly tables: Readonly<
      Record<IntegrationIdentityTableName, RowAggregate>
    >;
  };
  readonly dependencies: Readonly<
    Record<CatalogDependencyKind, DependencyComparison>
  >;
}

export interface ReadOnlySnapshotOptions {
  readonly signal?: AbortSignal;
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
}

export interface RowInventoryRow extends QueryResultRow {
  readonly tableName: string;
  readonly totalCount: string;
  readonly invalidCount: string;
}

interface CapabilityRow extends QueryResultRow {
  readonly serverVersion: number;
  readonly readOnly: boolean;
  readonly isolationLevel: string;
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

export const PREFLIGHT_OUTPUT_ALLOWLIST = [
  "capabilities.isolationLevel",
  "capabilities.lockTimeoutMs",
  "capabilities.serverVersionClassification",
  "capabilities.statementTimeoutMs",
  "capabilities.transactionReadOnly",
  ...CATALOG_DEPENDENCY_KINDS.flatMap((kind) => {
    return [
      `dependencies.${kind}.classification`,
      `dependencies.${kind}.expected.count`,
      `dependencies.${kind}.expected.digest`,
      `dependencies.${kind}.observed.count`,
      `dependencies.${kind}.observed.digest`,
    ];
  }),
  "failureGates",
  "rows.invalid_count",
  ...INTEGRATION_IDENTITY_TABLES.flatMap(({ tableName }) => {
    return [
      `rows.tables.${tableName}.invalid_count`,
      `rows.tables.${tableName}.total_count`,
    ];
  }),
  "rows.total_count",
  "schemaVersion",
  "status",
].sort();

export class SanitizedPreflightError extends Error {
  readonly gate: SanitizedFailureGate;

  constructor(gate: SanitizedFailureGate) {
    super(gate);
    this.name = "SanitizedPreflightError";
    this.gate = gate;
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SanitizedPreflightError("probe.cancelled");
}

function classifyThrownError(
  error: unknown,
  fallbackGate: SanitizedFailureGate,
): never {
  if (error instanceof SanitizedPreflightError) throw error;
  if (error instanceof DOMException && error.name === "AbortError") {
    throw new SanitizedPreflightError("probe.cancelled");
  }
  const code = (error as { readonly code?: unknown } | null)?.code;
  if (code === "57014") {
    throw new SanitizedPreflightError("probe.statement_timeout");
  }
  if (code === "55P03") {
    throw new SanitizedPreflightError("probe.lock_timeout");
  }
  throw new SanitizedPreflightError(fallbackGate);
}

async function safeQuery<Row extends QueryResultRow>(
  client: Client,
  signal: AbortSignal | undefined,
  text: string,
  values?: readonly unknown[],
): Promise<readonly Row[]> {
  assertNotAborted(signal);
  const result = await client.query<Row>(text, values as unknown[] | undefined);
  assertNotAborted(signal);
  return result.rows;
}

function fingerprintSortedSet(
  domain: string,
  members: readonly string[],
): SetFingerprint {
  const uniqueMembers = [...new Set(members)].sort();
  const hash = createHash("sha256");
  hash.update(SET_FINGERPRINT_DOMAIN);
  hash.update("\0");
  hash.update(domain);
  hash.update("\0");
  for (const member of uniqueMembers) {
    hash.update(Buffer.byteLength(member, "utf8").toString());
    hash.update(":");
    hash.update(member);
    hash.update("\0");
  }
  return { count: uniqueMembers.length, digest: hash.digest("hex") };
}

function compareDependencies(
  kind: CatalogDependencyKind,
  expectedMembers: readonly string[],
  observedMembers: readonly string[],
): DependencyComparison {
  const expected = fingerprintSortedSet(kind, expectedMembers);
  const observed = fingerprintSortedSet(kind, observedMembers);
  return {
    classification:
      expected.count === observed.count && expected.digest === observed.digest
        ? "exact"
        : "drift",
    expected,
    observed,
  };
}

function parseCount(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new SanitizedPreflightError("probe.aggregate_contract");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new SanitizedPreflightError("probe.aggregate_contract");
  }
  return parsed;
}

function outputLeafPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return [prefix];
  if (value === null || typeof value !== "object") return [prefix];
  return Object.entries(value).flatMap(([key, child]) => {
    return outputLeafPaths(
      child,
      prefix.length === 0 ? key : `${prefix}.${key}`,
    );
  });
}

function assertAllowedOutputPaths(value: unknown): void {
  const allowlist = new Set(PREFLIGHT_OUTPUT_ALLOWLIST);
  if (
    outputLeafPaths(value).some((path) => {
      return !allowlist.has(path);
    })
  ) {
    throw new SanitizedPreflightError("probe.output_contract");
  }
  const failureGates = (value as { readonly failureGates?: unknown } | null)
    ?.failureGates;
  if (
    !Array.isArray(failureGates) ||
    failureGates.some((gate) => {
      return (
        typeof gate !== "string" ||
        (!SANITIZED_PROBE_FAILURE_GATES.some((known) => {
          return known === gate;
        }) &&
          !INTEGRATION_IDENTITY_TABLES.some(({ tableName }) => {
            return gate === `rows.${tableName}.invalid`;
          }) &&
          !CATALOG_DEPENDENCY_KINDS.some((kind) => {
            return gate === `dependencies.${kind}`;
          }))
      );
    })
  ) {
    throw new SanitizedPreflightError("probe.output_contract");
  }
}

export function assertOutputAllowlist(value: unknown): void {
  assertAllowedOutputPaths(value);
  const observed = outputLeafPaths(value).sort();
  if (
    observed.length !== PREFLIGHT_OUTPUT_ALLOWLIST.length ||
    observed.some((path, index) => {
      return path !== PREFLIGHT_OUTPUT_ALLOWLIST[index];
    })
  ) {
    throw new SanitizedPreflightError("probe.output_contract");
  }
}

export function classifyPreflightInventory(
  capabilities: PreflightCapabilities,
  inventory: PreflightInventory,
  expectedCatalogDependencies: Readonly<
    Record<CatalogDependencyKind, readonly string[]>
  > = EXPECTED_CATALOG_DEPENDENCIES,
): SuccessfulPreflightResult {
  const expectedTables = new Set<string>(
    INTEGRATION_IDENTITY_TABLES.map(({ tableName }) => {
      return tableName;
    }),
  );
  const observedTables = new Set<string>();
  const tableAggregates = {} as Record<
    IntegrationIdentityTableName,
    RowAggregate
  >;
  let totalCount = 0;
  let invalidCount = 0;
  const failureGates: string[] = [];

  for (const row of inventory.rows) {
    if (
      !expectedTables.has(row.tableName) ||
      observedTables.has(row.tableName)
    ) {
      throw new SanitizedPreflightError("probe.row_inventory");
    }
    observedTables.add(row.tableName);
    const aggregate = {
      total_count: parseCount(row.totalCount),
      invalid_count: parseCount(row.invalidCount),
    };
    if (aggregate.invalid_count > aggregate.total_count) {
      throw new SanitizedPreflightError("probe.aggregate_contract");
    }
    tableAggregates[row.tableName as IntegrationIdentityTableName] = aggregate;
    totalCount += aggregate.total_count;
    invalidCount += aggregate.invalid_count;
    if (aggregate.invalid_count > 0) {
      failureGates.push(`rows.${row.tableName}.invalid`);
    }
  }
  if (observedTables.size !== expectedTables.size) {
    throw new SanitizedPreflightError("probe.row_inventory");
  }
  if (
    !Number.isSafeInteger(totalCount) ||
    !Number.isSafeInteger(invalidCount)
  ) {
    throw new SanitizedPreflightError("probe.aggregate_contract");
  }

  const observedCatalogDependencies = Object.fromEntries(
    CATALOG_DEPENDENCY_KINDS.map((kind) => {
      return [kind, [] as string[]];
    }),
  ) as Record<CatalogDependencyKind, string[]>;
  for (const sourceRow of inventory.catalogDependencies) {
    const normalized = normalizeCatalogDependencyRow(sourceRow);
    observedCatalogDependencies[normalized.kind].push(normalized.entry);
  }

  const dependencies = Object.fromEntries(
    CATALOG_DEPENDENCY_KINDS.map((kind) => {
      const comparison = compareDependencies(
        kind,
        expectedCatalogDependencies[kind],
        observedCatalogDependencies[kind],
      );
      if (comparison.classification !== "exact") {
        failureGates.push(`dependencies.${kind}`);
      }
      return [kind, comparison];
    }),
  ) as Record<CatalogDependencyKind, DependencyComparison>;

  failureGates.sort();
  const result: SuccessfulPreflightResult = {
    schemaVersion: PREFLIGHT_SCHEMA_VERSION,
    status: failureGates.length === 0 ? "passed" : "failed",
    failureGates,
    capabilities,
    rows: {
      total_count: totalCount,
      invalid_count: invalidCount,
      tables: Object.fromEntries(
        INTEGRATION_IDENTITY_TABLES.map(({ tableName }) => {
          return [tableName, tableAggregates[tableName]];
        }),
      ) as Record<IntegrationIdentityTableName, RowAggregate>,
    },
    dependencies,
  };
  assertOutputAllowlist(result);
  return result;
}

export async function withReadOnlySnapshot<Value>(
  client: Client,
  options: ReadOnlySnapshotOptions,
  body: (capabilities: PreflightCapabilities) => Promise<Value>,
): Promise<{
  readonly capabilities: PreflightCapabilities;
  readonly value: Value;
}> {
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const statementTimeoutMs =
    options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  let transactionStarted = false;
  let bodyError: unknown;
  let result:
    | { readonly capabilities: PreflightCapabilities; readonly value: Value }
    | undefined;

  try {
    assertNotAborted(options.signal);
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    transactionStarted = true;
    await client.query(
      `SELECT
         set_config('lock_timeout', $1, true),
         set_config('statement_timeout', $2, true)`,
      [`${lockTimeoutMs}ms`, `${statementTimeoutMs}ms`],
    );
    const capabilityRows = await safeQuery<CapabilityRow>(
      client,
      options.signal,
      `SELECT
         current_setting('server_version_num')::integer AS "serverVersion",
         current_setting('transaction_read_only') = 'on' AS "readOnly",
         current_setting('transaction_isolation') AS "isolationLevel",
         (SELECT "setting"::integer FROM "pg_settings"
          WHERE "name" = 'lock_timeout') AS "lockTimeoutMs",
         (SELECT "setting"::integer FROM "pg_settings"
          WHERE "name" = 'statement_timeout') AS "statementTimeoutMs"`,
    );
    const capability = capabilityRows[0];
    if (
      !capability ||
      capability.serverVersion < MINIMUM_SERVER_VERSION ||
      !capability.readOnly ||
      capability.isolationLevel !== "repeatable read" ||
      capability.lockTimeoutMs !== lockTimeoutMs ||
      capability.statementTimeoutMs !== statementTimeoutMs
    ) {
      throw new SanitizedPreflightError("probe.capability_gate");
    }
    const capabilities: PreflightCapabilities = {
      serverVersionClassification: "supported",
      transactionReadOnly: true,
      isolationLevel: "repeatable read",
      lockTimeoutMs,
      statementTimeoutMs,
    };
    result = { capabilities, value: await body(capabilities) };
  } catch (error) {
    bodyError = error;
  }

  if (transactionStarted) {
    try {
      await client.query("ROLLBACK");
    } catch {
      throw new SanitizedPreflightError("probe.transaction_cleanup");
    }
  }
  if (bodyError !== undefined) {
    classifyThrownError(bodyError, "probe.inventory");
  }
  if (!result) throw new SanitizedPreflightError("probe.transaction_start");
  return result;
}

async function collectDatabaseInventory(
  client: Client,
  signal: AbortSignal | undefined,
): Promise<PreflightInventory> {
  const catalogDependencies = await safeQuery<CatalogDependencySourceRow>(
    client,
    signal,
    CATALOG_DEPENDENCY_QUERY,
  );
  const rows = await safeQuery<RowInventoryRow>(
    client,
    signal,
    ROW_INVENTORY_QUERY,
  );
  return { rows, catalogDependencies };
}

export async function executeIntegrationIdentityContractReadinessPreflight(args: {
  readonly connectionString: string;
  readonly signal?: AbortSignal;
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
}): Promise<SuccessfulPreflightResult> {
  const client = new Client({ connectionString: args.connectionString });
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (error) {
    classifyThrownError(error, "probe.database_connection");
  }

  try {
    const snapshot = await withReadOnlySnapshot(
      client,
      {
        signal: args.signal,
        lockTimeoutMs: args.lockTimeoutMs,
        statementTimeoutMs: args.statementTimeoutMs,
      },
      async () => {
        return collectDatabaseInventory(client, args.signal);
      },
    );
    return classifyPreflightInventory(snapshot.capabilities, snapshot.value);
  } catch (error) {
    classifyThrownError(error, "probe.inventory");
  } finally {
    await client.end().catch(() => {});
  }
}

export function sanitizedFailureResult(error: unknown): {
  readonly schemaVersion: string;
  readonly status: "failed";
  readonly failureGates: readonly string[];
} {
  const result = {
    schemaVersion: PREFLIGHT_SCHEMA_VERSION,
    status: "failed" as const,
    failureGates: [
      error instanceof SanitizedPreflightError
        ? error.gate
        : "probe.unexpected",
    ],
  };
  assertAllowedOutputPaths(result);
  return result;
}

async function runCli(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    process.stdout.write(
      `${JSON.stringify(sanitizedFailureResult(new SanitizedPreflightError("probe.configuration")))}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const abortController = new AbortController();
  const abort = (): void => {
    return abortController.abort();
  };
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const result = await executeIntegrationIdentityContractReadinessPreflight({
      connectionString: databaseUrl,
      signal: abortController.signal,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== "passed") process.exitCode = 1;
  } catch (error) {
    const result = sanitizedFailureResult(error);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli().catch((error: unknown) => {
    process.stdout.write(`${JSON.stringify(sanitizedFailureResult(error))}\n`);
    process.exitCode = 1;
  });
}
