#!/usr/bin/env tsx

/**
 * Backfill processed legacy credit_usage model-token rows into usage_event.
 *
 * Required environment:
 *   DATABASE_URL - target Postgres database. No other service credentials are
 *   read by this script.
 *
 * Usage:
 *   cd turbo/apps/web
 *
 *   # Dry-run only. Prints source counts, planned usage_event rows, warnings,
 *   # and errors. This is the default mode and does not write to the database.
 *   pnpm exec dotenv -e .env.local -- tsx scripts/migrations/007-backfill-credit-usage-to-usage-event/backfill.ts
 *
 *   # Write rows after the same validation pass succeeds.
 *   pnpm exec dotenv -e .env.local -- tsx scripts/migrations/007-backfill-credit-usage-to-usage-event/backfill.ts --migrate
 *
 * Optional flags:
 *   --org-id=org_xxx       scope to one org; omitted means all orgs
 *   --limit=100            scan at most 100 source rows
 *   --batch-size=250       override the default 500 row batch size; max 1000
 *   --fail-on-anomaly      treat warnings as fatal
 *
 * If DATABASE_URL is already exported in the shell, omit the dotenv wrapper.
 */

import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import process from "node:process";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "@vm0/db";
import { creditPricing } from "@vm0/db/schema/credit-pricing";
import { creditUsage } from "@vm0/db/schema/credit-usage";
import { usageEvent } from "@vm0/db/schema/usage-event";

export const MODEL_USAGE_EVENT_NAMESPACE =
  "18a22204-d25e-4170-8973-86477f864bfb";
const BACKFILL_RESULT_SOURCE = "credit-usage-backfill:v1";
const NULL_RUN_ID = "<null-run-id>";
const NULL_MESSAGE_ID = "<null-message-id>";
const NULL_RESULT_UUID = "<null-result-uuid>";
const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 1_000;
const MAX_PROVIDER_LENGTH = 100;
const CREDITS_UNIT_SIZE = 1_000_000;
const ISSUE_SAMPLE_LIMIT = 5;

const TOKEN_CATEGORIES = [
  {
    category: "tokens.input",
    sourceField: "inputTokens",
    pricingField: "inputTokenPrice",
  },
  {
    category: "tokens.output",
    sourceField: "outputTokens",
    pricingField: "outputTokenPrice",
  },
  {
    category: "tokens.cache_read",
    sourceField: "cacheReadInputTokens",
    pricingField: "cacheReadTokenPrice",
  },
  {
    category: "tokens.cache_creation",
    sourceField: "cacheCreationInputTokens",
    pricingField: "cacheCreationTokenPrice",
  },
] as const;

type TokenCategory = (typeof TOKEN_CATEGORIES)[number]["category"];
type PricingField = (typeof TOKEN_CATEGORIES)[number]["pricingField"];
type Db = PostgresJsDatabase<typeof schema>;

export interface CliOptions {
  migrate: boolean;
  batchSize: number;
  orgId?: string;
  limit?: number;
  failOnAnomaly: boolean;
}

export interface CreditUsageSourceRow {
  id: string;
  runId: string | null;
  resultUuid: string | null;
  messageId: string | null;
  orgId: string;
  userId: string;
  model: string;
  modelProvider: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  creditsCharged: number | null;
  status: string;
  createdAt: Date;
  processedAt: Date | null;
}

export interface CreditPricingRow {
  model: string;
  modelProvider: string;
  inputTokenPrice: number;
  outputTokenPrice: number;
  cacheReadTokenPrice: number;
  cacheCreationTokenPrice: number;
}

export interface PlannedUsageEvent {
  sourceId: string;
  idempotencyKey: string;
  runId: string | null;
  orgId: string;
  userId: string;
  kind: "model";
  provider: string;
  category: TokenCategory;
  quantity: number;
  creditsCharged: number | null;
  status: "processed";
  billingError: null;
  createdAt: Date;
  processedAt: Date;
}

interface ExistingUsageEventRow {
  idempotencyKey: string;
  runId: string | null;
  orgId: string;
  userId: string;
  kind: string;
  provider: string;
  category: string;
  quantity: number;
  creditsCharged: number | null;
  status: string;
  createdAt: Date;
  processedAt: Date | null;
}

interface IssueCounter {
  count: number;
  samples: string[];
}

export interface PlanningStats {
  processedSourceRows: number;
  eligibleSourceRows: number;
  pendingSourceRows: number;
  zeroTokenSourceRows: number;
  negativeTokenSourceRows: number;
  providerTooLongSourceRows: number;
  scannedSourceRows: number;
  plannedSourceRows: number;
  plannedUsageEvents: number;
  insertedUsageEvents: number;
  existingUsageEvents: number;
  pricingMatchedRows: number;
  fallbackAllocatedRows: number;
  nullCreditsRows: number;
  knownSourceCredits: number;
  plannedKnownCredits: number;
  errors: Map<string, IssueCounter>;
  warnings: Map<string, IssueCounter>;
}

interface CreditSplitResult {
  creditsByCategory: Map<TokenCategory, number | null>;
  strategy: "null" | "single" | "pricing" | "token-allocation";
  warning?: { code: string; message: string };
}

function createStats(): PlanningStats {
  return {
    processedSourceRows: 0,
    eligibleSourceRows: 0,
    pendingSourceRows: 0,
    zeroTokenSourceRows: 0,
    negativeTokenSourceRows: 0,
    providerTooLongSourceRows: 0,
    scannedSourceRows: 0,
    plannedSourceRows: 0,
    plannedUsageEvents: 0,
    insertedUsageEvents: 0,
    existingUsageEvents: 0,
    pricingMatchedRows: 0,
    fallbackAllocatedRows: 0,
    nullCreditsRows: 0,
    knownSourceCredits: 0,
    plannedKnownCredits: 0,
    errors: new Map(),
    warnings: new Map(),
  };
}

function recordIssue(
  issues: Map<string, IssueCounter>,
  code: string,
  sample: string,
): void {
  const current = issues.get(code) ?? { count: 0, samples: [] };
  current.count++;
  if (current.samples.length < ISSUE_SAMPLE_LIMIT) {
    current.samples.push(sample);
  }
  issues.set(code, current);
}

function recordError(stats: PlanningStats, code: string, sample: string): void {
  recordIssue(stats.errors, code, sample);
}

function recordWarning(
  stats: PlanningStats,
  code: string,
  sample: string,
): void {
  recordIssue(stats.warnings, code, sample);
}

function issueCount(issues: Map<string, IssueCounter>): number {
  let total = 0;
  for (const issue of issues.values()) {
    total += issue.count;
  }
  return total;
}

export function parseCliOptions(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      migrate: { type: "boolean", default: false },
      "batch-size": { type: "string", default: String(DEFAULT_BATCH_SIZE) },
      "org-id": { type: "string" },
      limit: { type: "string" },
      "fail-on-anomaly": { type: "boolean", default: false },
    },
    strict: true,
  });

  return {
    migrate: values.migrate ?? false,
    batchSize: parsePositiveInteger(
      values["batch-size"],
      "--batch-size",
      DEFAULT_BATCH_SIZE,
      MAX_BATCH_SIZE,
    ),
    orgId: parseOptionalOrgId(values["org-id"]),
    limit:
      values.limit === undefined
        ? undefined
        : parsePositiveInteger(values.limit, "--limit"),
    failOnAnomaly: values["fail-on-anomaly"] ?? false,
  };
}

function parsePositiveInteger(
  value: string | undefined,
  name: string,
  fallback?: number,
  max?: number,
): number {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${name} is required`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  if (max !== undefined && parsed > max) {
    throw new Error(`${name} must be <= ${max}`);
  }
  return parsed;
}

function parseOptionalOrgId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim().length === 0) {
    throw new Error("--org-id must not be blank");
  }
  return value;
}

export function encodeUuidName(parts: readonly string[]): string {
  return parts
    .map((part) => {
      return `${Buffer.byteLength(part, "utf8")}:${part}`;
    })
    .join("\0");
}

export function uuidV5(namespaceUuid: string, name: string): string {
  const namespace = Buffer.from(namespaceUuid.replaceAll("-", ""), "hex");
  if (namespace.length !== 16) {
    throw new Error(`Invalid UUID namespace: ${namespaceUuid}`);
  }

  const hash = createHash("sha1")
    .update(namespace)
    .update(Buffer.from(name, "utf8"))
    .digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function deriveUsageEventIdempotencyKey(
  row: Pick<CreditUsageSourceRow, "id" | "runId" | "messageId" | "resultUuid">,
  category: TokenCategory,
): string {
  if (row.runId && row.messageId) {
    return uuidV5(
      MODEL_USAGE_EVENT_NAMESPACE,
      encodeUuidName([row.runId, row.messageId, category]),
    );
  }

  return uuidV5(
    MODEL_USAGE_EVENT_NAMESPACE,
    encodeUuidName([
      BACKFILL_RESULT_SOURCE,
      row.id,
      row.runId ?? NULL_RUN_ID,
      row.messageId ?? NULL_MESSAGE_ID,
      row.resultUuid ?? NULL_RESULT_UUID,
      category,
    ]),
  );
}

function positiveTokenEntries(
  row: CreditUsageSourceRow,
): Array<{ category: TokenCategory; quantity: number }> {
  return TOKEN_CATEGORIES.flatMap((token) => {
    const quantity = row[token.sourceField];
    if (quantity <= 0) return [];
    return [{ category: token.category, quantity }];
  });
}

function hasNegativeTokens(row: CreditUsageSourceRow): boolean {
  return TOKEN_CATEGORIES.some((token) => {
    return row[token.sourceField] < 0;
  });
}

function validateSourceNumbers(row: CreditUsageSourceRow): void {
  if (hasNegativeTokens(row)) {
    throw new Error("source row contains negative token quantity");
  }

  for (const token of TOKEN_CATEGORIES) {
    if (!Number.isSafeInteger(row[token.sourceField])) {
      throw new Error(`source ${token.sourceField} is not a safe integer`);
    }
  }

  if (row.creditsCharged === null) return;
  if (row.creditsCharged < 0) {
    throw new Error("source credits_charged is negative");
  }
  if (!Number.isSafeInteger(row.creditsCharged)) {
    throw new Error("source credits_charged is not a safe integer");
  }
}

function pricingKey(model: string, modelProvider: string): string {
  return `${model}\0${modelProvider}`;
}

function pricingValue(
  pricing: CreditPricingRow,
  category: TokenCategory,
): number {
  const token = TOKEN_CATEGORIES.find((entry) => {
    return entry.category === category;
  });
  if (!token) {
    throw new Error(`Unknown token category: ${category}`);
  }
  const value = pricing[token.pricingField as PricingField];
  if (value < 0) {
    throw new Error(`negative credit pricing for ${category}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`credit pricing for ${category} is not a safe integer`);
  }
  return value;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function safeBigIntToNumber(value: bigint, label: string): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) {
    throw new Error(`${label} is not a safe integer`);
  }
  return numeric;
}

export function splitCreditsForSourceRow(
  row: CreditUsageSourceRow,
  pricing: CreditPricingRow | undefined,
): CreditSplitResult {
  validateSourceNumbers(row);

  const positiveEntries = positiveTokenEntries(row);
  const creditsByCategory = new Map<TokenCategory, number | null>();

  if (row.creditsCharged === null) {
    for (const entry of positiveEntries) {
      creditsByCategory.set(entry.category, null);
    }
    return {
      creditsByCategory,
      strategy: "null",
      warning: {
        code: "null_credits_charged",
        message: "source credits_charged is NULL; target rows keep NULL",
      },
    };
  }

  if (positiveEntries.length === 1) {
    creditsByCategory.set(positiveEntries[0]!.category, row.creditsCharged);
    return { creditsByCategory, strategy: "single" };
  }

  if (pricing) {
    let pricingTotal = 0n;
    const pricingSplit = new Map<TokenCategory, bigint>();
    for (const entry of positiveEntries) {
      const categoryCredits = ceilDiv(
        BigInt(entry.quantity) * BigInt(pricingValue(pricing, entry.category)),
        BigInt(CREDITS_UNIT_SIZE),
      );
      pricingSplit.set(entry.category, categoryCredits);
      pricingTotal += categoryCredits;
    }

    if (pricingTotal === BigInt(row.creditsCharged)) {
      for (const [category, categoryCredits] of pricingSplit) {
        creditsByCategory.set(
          category,
          safeBigIntToNumber(
            categoryCredits,
            `pricing credits for ${category}`,
          ),
        );
      }
      return { creditsByCategory, strategy: "pricing" };
    }
  }

  const fallbackSplit = allocateCreditsByTokenQuantity(
    row.creditsCharged,
    positiveEntries,
  );
  for (const [category, categoryCredits] of fallbackSplit) {
    creditsByCategory.set(category, categoryCredits);
  }

  return {
    creditsByCategory,
    strategy: "token-allocation",
    warning: pricing
      ? {
          code: "pricing_mismatch",
          message:
            "current credit_pricing split did not match source credits_charged",
        }
      : {
          code: "missing_credit_pricing",
          message:
            "no current credit_pricing row matched source model/provider",
        },
  };
}

function allocateCreditsByTokenQuantity(
  totalCredits: number,
  entries: Array<{ category: TokenCategory; quantity: number }>,
): Map<TokenCategory, number> {
  if (entries.length === 0) {
    return new Map();
  }

  if (totalCredits === 0) {
    return new Map(
      entries.map((entry) => {
        return [entry.category, 0];
      }),
    );
  }

  const totalQuantity = entries.reduce((sum, entry) => {
    return sum + BigInt(entry.quantity);
  }, 0n);
  if (totalQuantity <= 0n) {
    throw new Error("cannot allocate credits without positive token quantity");
  }
  const totalCreditsBigInt = BigInt(totalCredits);

  const floors = entries.map((entry, index) => {
    const numerator = totalCreditsBigInt * BigInt(entry.quantity);
    const floor = numerator / totalQuantity;
    return {
      category: entry.category,
      floor: safeBigIntToNumber(
        floor,
        `allocated credits for ${entry.category}`,
      ),
      fractionalNumerator: numerator % totalQuantity,
      index,
    };
  });

  let allocated = floors.reduce((sum, entry) => {
    return sum + entry.floor;
  }, 0);
  let remainder = totalCredits - allocated;

  const byRemainder = [...floors].sort((left, right) => {
    if (right.fractionalNumerator !== left.fractionalNumerator) {
      return right.fractionalNumerator > left.fractionalNumerator ? 1 : -1;
    }
    return left.index - right.index;
  });

  const result = new Map<TokenCategory, number>();
  for (const entry of floors) {
    result.set(entry.category, entry.floor);
  }

  for (const entry of byRemainder) {
    if (remainder <= 0) break;
    result.set(entry.category, (result.get(entry.category) ?? 0) + 1);
    remainder--;
  }

  allocated = [...result.values()].reduce((sum, value) => {
    return sum + value;
  }, 0);
  if (allocated !== totalCredits) {
    throw new Error("credit allocation failed to preserve source total");
  }

  return result;
}

export function planUsageEventsForSourceRow(
  row: CreditUsageSourceRow,
  pricing: CreditPricingRow | undefined,
): { events: PlannedUsageEvent[]; split: CreditSplitResult } {
  if (row.status !== "processed") {
    throw new Error("source row is not processed");
  }
  if (!row.processedAt) {
    throw new Error("source row has no processed_at");
  }
  if (row.model.length > MAX_PROVIDER_LENGTH) {
    throw new Error("source model is too long for usage_event.provider");
  }
  validateSourceNumbers(row);

  const positiveEntries = positiveTokenEntries(row);
  if (positiveEntries.length === 0) {
    throw new Error("source row has no positive token categories");
  }

  const processedAt = row.processedAt;
  const split = splitCreditsForSourceRow(row, pricing);
  const events = positiveEntries.map((entry) => {
    return {
      sourceId: row.id,
      idempotencyKey: deriveUsageEventIdempotencyKey(row, entry.category),
      runId: row.runId,
      orgId: row.orgId,
      userId: row.userId,
      kind: "model" as const,
      provider: row.model,
      category: entry.category,
      quantity: entry.quantity,
      creditsCharged: splitCreditForCategory(split, entry.category),
      status: "processed" as const,
      billingError: null,
      createdAt: row.createdAt,
      processedAt,
    };
  });

  return { events, split };
}

function sourceBaseConditions(options: CliOptions): SQL<unknown>[] {
  const conditions: SQL<unknown>[] = [
    eq(creditUsage.status, "processed"),
    isNotNull(creditUsage.processedAt),
  ];
  if (options.orgId) {
    conditions.push(eq(creditUsage.orgId, options.orgId));
  }
  return conditions;
}

function positiveTokenCondition(): SQL<unknown> {
  return or(
    gt(creditUsage.inputTokens, 0),
    gt(creditUsage.outputTokens, 0),
    gt(creditUsage.cacheReadInputTokens, 0),
    gt(creditUsage.cacheCreationInputTokens, 0),
  )!;
}

function negativeTokenCondition(): SQL<unknown> {
  return or(
    lt(creditUsage.inputTokens, 0),
    lt(creditUsage.outputTokens, 0),
    lt(creditUsage.cacheReadInputTokens, 0),
    lt(creditUsage.cacheCreationInputTokens, 0),
  )!;
}

function zeroTokenCondition(): SQL<unknown> {
  return and(
    eq(creditUsage.inputTokens, 0),
    eq(creditUsage.outputTokens, 0),
    eq(creditUsage.cacheReadInputTokens, 0),
    eq(creditUsage.cacheCreationInputTokens, 0),
  )!;
}

async function countCreditUsageRows(
  db: Db,
  conditions: SQL<unknown>[],
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(creditUsage)
    .where(and(...conditions));
  return Number(row?.count ?? 0);
}

async function loadPreflightCounts(
  db: Db,
  options: CliOptions,
  stats: PlanningStats,
): Promise<void> {
  const base = sourceBaseConditions(options);
  const pendingConditions: SQL<unknown>[] = [eq(creditUsage.status, "pending")];
  if (options.orgId) {
    pendingConditions.push(eq(creditUsage.orgId, options.orgId));
  }

  stats.processedSourceRows = await countCreditUsageRows(db, base);
  stats.eligibleSourceRows = await countCreditUsageRows(db, [
    ...base,
    positiveTokenCondition(),
  ]);
  stats.pendingSourceRows = await countCreditUsageRows(db, pendingConditions);
  stats.zeroTokenSourceRows = await countCreditUsageRows(db, [
    ...base,
    zeroTokenCondition(),
  ]);
  stats.negativeTokenSourceRows = await countCreditUsageRows(db, [
    ...base,
    negativeTokenCondition(),
  ]);
  stats.providerTooLongSourceRows = await countCreditUsageRows(db, [
    ...base,
    positiveTokenCondition(),
    sql`length(${creditUsage.model}) > ${MAX_PROVIDER_LENGTH}`,
  ]);

  if (stats.pendingSourceRows > 0) {
    recordWarning(
      stats,
      "pending_credit_usage_rows",
      `${stats.pendingSourceRows} pending credit_usage rows still exist`,
    );
  }
  if (stats.negativeTokenSourceRows > 0) {
    recordError(
      stats,
      "negative_token_rows",
      `${stats.negativeTokenSourceRows} processed rows contain negative token quantities`,
    );
  }
  if (stats.providerTooLongSourceRows > 0) {
    recordError(
      stats,
      "provider_too_long_rows",
      `${stats.providerTooLongSourceRows} source models exceed usage_event.provider length`,
    );
  }
}

async function fetchPricingMap(db: Db): Promise<Map<string, CreditPricingRow>> {
  const rows = await db.select().from(creditPricing);
  return new Map(
    rows.map((row) => {
      return [pricingKey(row.model, row.modelProvider), row];
    }),
  );
}

async function fetchSourceBatch(
  db: Db,
  options: CliOptions,
  cursorId: string | undefined,
  remainingLimit: number | undefined,
): Promise<CreditUsageSourceRow[]> {
  const batchLimit =
    remainingLimit === undefined
      ? options.batchSize
      : Math.min(options.batchSize, remainingLimit);
  const conditions = [
    ...sourceBaseConditions(options),
    positiveTokenCondition(),
  ];
  if (cursorId) {
    conditions.push(gt(creditUsage.id, cursorId));
  }

  // Use the UUID primary key as the keyset cursor. The table's timestamp
  // columns have microsecond precision, but JavaScript Date only preserves
  // milliseconds; timestamp cursors can therefore re-read the final row.
  return await db
    .select()
    .from(creditUsage)
    .where(and(...conditions))
    .orderBy(asc(creditUsage.id))
    .limit(batchLimit);
}

async function fetchExistingUsageEvents(
  db: Db,
  keys: string[],
): Promise<Map<string, ExistingUsageEventRow>> {
  if (keys.length === 0) return new Map();
  const rows = await db
    .select({
      idempotencyKey: usageEvent.idempotencyKey,
      runId: usageEvent.runId,
      orgId: usageEvent.orgId,
      userId: usageEvent.userId,
      kind: usageEvent.kind,
      provider: usageEvent.provider,
      category: usageEvent.category,
      quantity: usageEvent.quantity,
      creditsCharged: usageEvent.creditsCharged,
      status: usageEvent.status,
      createdAt: usageEvent.createdAt,
      processedAt: usageEvent.processedAt,
    })
    .from(usageEvent)
    .where(inArray(usageEvent.idempotencyKey, keys));

  return new Map(
    rows.map((row) => {
      return [row.idempotencyKey, row];
    }),
  );
}

function sameNullableDate(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) return left === right;
  return left.getTime() === right.getTime();
}

function describeExistingConflict(
  planned: PlannedUsageEvent,
  existing: ExistingUsageEventRow,
): string | undefined {
  const mismatches: string[] = [];
  if (existing.runId !== planned.runId) mismatches.push("run_id");
  if (existing.orgId !== planned.orgId) mismatches.push("org_id");
  if (existing.userId !== planned.userId) mismatches.push("user_id");
  if (existing.kind !== planned.kind) mismatches.push("kind");
  if (existing.provider !== planned.provider) mismatches.push("provider");
  if (existing.category !== planned.category) mismatches.push("category");
  if (existing.quantity !== planned.quantity) mismatches.push("quantity");
  if (existing.creditsCharged !== planned.creditsCharged) {
    mismatches.push("credits_charged");
  }
  if (existing.status !== planned.status) mismatches.push("status");
  if (!sameNullableDate(existing.createdAt, planned.createdAt)) {
    mismatches.push("created_at");
  }
  if (!sameNullableDate(existing.processedAt, planned.processedAt)) {
    mismatches.push("processed_at");
  }

  if (mismatches.length === 0) return undefined;
  return `source ${planned.sourceId} idempotency ${planned.idempotencyKey} mismatched fields: ${mismatches.join(", ")}`;
}

function sumKnownCredits(events: PlannedUsageEvent[]): number {
  return events.reduce((sum, event) => {
    return sum + (event.creditsCharged ?? 0);
  }, 0);
}

function validateCreditParity(
  row: CreditUsageSourceRow,
  events: PlannedUsageEvent[],
): void {
  if (row.creditsCharged === null) {
    const hasKnownCredit = events.some((event) => {
      return event.creditsCharged !== null;
    });
    if (hasKnownCredit) {
      throw new Error("NULL source credits produced non-NULL target credits");
    }
    return;
  }

  const eventTotal = sumKnownCredits(events);
  if (eventTotal !== row.creditsCharged) {
    throw new Error(
      `source credits ${row.creditsCharged} != planned event credits ${eventTotal}`,
    );
  }
}

function splitCreditForCategory(
  split: CreditSplitResult,
  category: TokenCategory,
): number | null {
  if (!split.creditsByCategory.has(category)) {
    throw new Error(`missing credit split for ${category}`);
  }
  return split.creditsByCategory.get(category)!;
}

function updateStatsForPlan(
  stats: PlanningStats,
  row: CreditUsageSourceRow,
  events: PlannedUsageEvent[],
  split: CreditSplitResult,
): void {
  stats.plannedSourceRows++;
  stats.plannedUsageEvents += events.length;

  if (row.creditsCharged === null) {
    stats.nullCreditsRows++;
  } else {
    stats.knownSourceCredits += row.creditsCharged;
    stats.plannedKnownCredits += sumKnownCredits(events);
  }

  if (split.strategy === "pricing") {
    stats.pricingMatchedRows++;
  }
  if (split.strategy === "token-allocation") {
    stats.fallbackAllocatedRows++;
  }
}

function recordPlanWarnings(
  stats: PlanningStats,
  row: CreditUsageSourceRow,
  split: CreditSplitResult,
): void {
  if (row.runId === null) {
    recordWarning(stats, "null_run_id", `source ${row.id} has run_id NULL`);
  }
  if (!row.messageId) {
    recordWarning(
      stats,
      "result_uuid_identity",
      `source ${row.id} has no message_id; using backfill idempotency shape`,
    );
  }
  if (row.webSearchRequests > 0) {
    recordWarning(
      stats,
      "web_search_requests_ignored",
      `source ${row.id} has web_search_requests=${row.webSearchRequests}; legacy processor did not charge it`,
    );
  }
  if (split.warning) {
    recordWarning(
      stats,
      split.warning.code,
      `source ${row.id}: ${split.warning.message}`,
    );
  }
}

async function planBatch(
  db: Db,
  rows: CreditUsageSourceRow[],
  pricingByKey: Map<string, CreditPricingRow>,
  stats: PlanningStats,
  seenKeys: Set<string>,
): Promise<PlannedUsageEvent[]> {
  const planned: PlannedUsageEvent[] = [];

  for (const row of rows) {
    stats.scannedSourceRows++;
    try {
      const pricing = pricingByKey.get(
        pricingKey(row.model, row.modelProvider),
      );
      const { events, split } = planUsageEventsForSourceRow(row, pricing);
      validateCreditParity(row, events);
      updateStatsForPlan(stats, row, events, split);
      recordPlanWarnings(stats, row, split);

      for (const event of events) {
        if (seenKeys.has(event.idempotencyKey)) {
          recordError(
            stats,
            "duplicate_planned_idempotency_key",
            `source ${row.id} produced duplicate key ${event.idempotencyKey}`,
          );
        }
        seenKeys.add(event.idempotencyKey);
      }

      planned.push(...events);
    } catch (err) {
      recordError(
        stats,
        "source_row_unmappable",
        `source ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const existingByKey = await fetchExistingUsageEvents(
    db,
    planned.map((event) => {
      return event.idempotencyKey;
    }),
  );
  for (const event of planned) {
    const existing = existingByKey.get(event.idempotencyKey);
    if (!existing) continue;

    stats.existingUsageEvents++;
    const conflict = describeExistingConflict(event, existing);
    if (conflict) {
      recordError(stats, "existing_usage_event_conflict", conflict);
    }
  }

  return planned;
}

async function runPlanningPass(
  db: Db,
  options: CliOptions,
): Promise<PlanningStats> {
  const stats = createStats();
  await loadPreflightCounts(db, options, stats);
  const pricingByKey = await fetchPricingMap(db);
  const seenKeys = new Set<string>();
  let cursorId: string | undefined;
  let remainingLimit = options.limit;

  for (;;) {
    if (remainingLimit !== undefined && remainingLimit <= 0) break;
    const rows = await fetchSourceBatch(db, options, cursorId, remainingLimit);
    if (rows.length === 0) break;

    await planBatch(db, rows, pricingByKey, stats, seenKeys);

    const last = rows[rows.length - 1]!;
    cursorId = last.id;
    if (remainingLimit !== undefined) {
      remainingLimit -= rows.length;
    }
  }

  return stats;
}

async function runWritePass(db: Db, options: CliOptions): Promise<number> {
  const pricingByKey = await fetchPricingMap(db);
  let cursorId: string | undefined;
  let remainingLimit = options.limit;
  let inserted = 0;

  for (;;) {
    if (remainingLimit !== undefined && remainingLimit <= 0) break;
    const rows = await fetchSourceBatch(db, options, cursorId, remainingLimit);
    if (rows.length === 0) break;

    const planned: PlannedUsageEvent[] = [];
    for (const row of rows) {
      const pricing = pricingByKey.get(
        pricingKey(row.model, row.modelProvider),
      );
      planned.push(...planUsageEventsForSourceRow(row, pricing).events);
    }

    if (planned.length > 0) {
      const insertedRows = await db
        .insert(usageEvent)
        .values(
          planned.map((event) => {
            return {
              runId: event.runId,
              idempotencyKey: event.idempotencyKey,
              orgId: event.orgId,
              userId: event.userId,
              kind: event.kind,
              provider: event.provider,
              category: event.category,
              quantity: event.quantity,
              creditsCharged: event.creditsCharged,
              status: event.status,
              billingError: event.billingError,
              createdAt: event.createdAt,
              processedAt: event.processedAt,
            };
          }),
        )
        .onConflictDoNothing({ target: usageEvent.idempotencyKey })
        .returning({ id: usageEvent.id });
      inserted += insertedRows.length;
    }

    const last = rows[rows.length - 1]!;
    cursorId = last.id;
    if (remainingLimit !== undefined) {
      remainingLimit -= rows.length;
    }
  }

  return inserted;
}

function printIssueMap(title: string, issues: Map<string, IssueCounter>): void {
  console.log(`\n${title}: ${issueCount(issues)}`);
  if (issues.size === 0) return;

  for (const [code, issue] of [...issues.entries()].sort()) {
    console.log(`  ${code}: ${issue.count}`);
    for (const sample of issue.samples) {
      console.log(`    - ${sample}`);
    }
  }
}

function printStats(stats: PlanningStats, mode: "dry-run" | "migrate"): void {
  console.log(`credit_usage -> usage_event backfill (${mode})`);
  console.log("");
  console.log("Source summary:");
  console.log(`  processed rows:       ${stats.processedSourceRows}`);
  console.log(`  eligible rows:        ${stats.eligibleSourceRows}`);
  console.log(`  scanned rows:         ${stats.scannedSourceRows}`);
  console.log(`  planned source rows:  ${stats.plannedSourceRows}`);
  console.log(`  zero-token rows:      ${stats.zeroTokenSourceRows}`);
  console.log(`  pending rows:         ${stats.pendingSourceRows}`);
  console.log(`  negative-token rows:  ${stats.negativeTokenSourceRows}`);
  console.log(`  provider-too-long:    ${stats.providerTooLongSourceRows}`);
  console.log("");
  console.log("Target summary:");
  console.log(`  planned usage_event rows: ${stats.plannedUsageEvents}`);
  console.log(`  existing usage_event rows: ${stats.existingUsageEvents}`);
  console.log(`  inserted usage_event rows: ${stats.insertedUsageEvents}`);
  console.log("");
  console.log("Credit split summary:");
  console.log(`  pricing-matched rows:      ${stats.pricingMatchedRows}`);
  console.log(`  fallback-allocated rows:   ${stats.fallbackAllocatedRows}`);
  console.log(`  NULL credits rows:         ${stats.nullCreditsRows}`);
  console.log(`  known source credits:      ${stats.knownSourceCredits}`);
  console.log(`  planned known credits:     ${stats.plannedKnownCredits}`);

  printIssueMap("Warnings", stats.warnings);
  printIssueMap("Errors", stats.errors);
}

function validationErrorForStats(
  stats: PlanningStats,
  options: CliOptions,
): string | undefined {
  const warningTotal = issueCount(stats.warnings);
  const errorTotal = issueCount(stats.errors);

  if (errorTotal > 0) {
    return "Backfill validation failed with errors";
  }
  if (options.failOnAnomaly && warningTotal > 0) {
    return "Backfill validation failed because --fail-on-anomaly was set";
  }
  return undefined;
}

async function runBackfill(options: CliOptions): Promise<PlanningStats> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    const stats = await runPlanningPass(db, options);
    const validationError = validationErrorForStats(stats, options);
    if (validationError) {
      printStats(stats, options.migrate ? "migrate" : "dry-run");
      throw new Error(validationError);
    }

    if (options.migrate) {
      stats.insertedUsageEvents = await runWritePass(db, options);
    }

    printStats(stats, options.migrate ? "migrate" : "dry-run");
    return stats;
  } finally {
    await client.end();
  }
}

export async function runBackfillWithDb(
  db: Db,
  options: CliOptions,
): Promise<PlanningStats> {
  const stats = await runPlanningPass(db, options);
  const validationError = validationErrorForStats(stats, options);
  if (validationError) {
    throw new Error(validationError);
  }

  if (options.migrate) {
    stats.insertedUsageEvents = await runWritePass(db, options);
  }

  return stats;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (!options.migrate) {
    console.log("DRY RUN: pass --migrate to insert usage_event rows.\n");
  }
  await runBackfill(options);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
