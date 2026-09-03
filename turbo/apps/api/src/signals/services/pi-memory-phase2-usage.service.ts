import { MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS } from "@okouai/api-contracts/contracts/model-price-tiers";
import { usageEvent } from "@okouai/db/schema/usage-event";
import type { PiMemoryPhase2ProviderUsage } from "@okouai/pi-agent-runtime/api";
import { inArray } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";

import type { Db } from "../external/db";

const PI_MEMORY_PHASE2_USAGE_NAMESPACE = "cae7f79f-7180-46db-aaed-84228c63d0d8";
export const PI_MEMORY_PHASE2_MODEL = "gpt-5.6-terra";

type UsageCategoryBase =
  | "tokens.input"
  | "tokens.output"
  | "tokens.cache_read"
  | "tokens.cache_creation";
type UsageCategory = UsageCategoryBase | `${UsageCategoryBase}.long_context`;

interface UsageEntry {
  readonly category: UsageCategory;
  readonly quantity: number;
}

interface RecordPiMemoryPhase2UsageArgs {
  readonly memoryStorageId: string;
  readonly claimedRevision: number;
  readonly selectionDigest: string;
  readonly orgId: string;
  readonly userId: string;
  readonly responseId: string;
  readonly usage: PiMemoryPhase2ProviderUsage;
}

function quantity(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Pi memory Phase 2 ${field} usage is invalid`);
  }
  return value;
}

function usageEntries(usage: PiMemoryPhase2ProviderUsage): UsageEntry[] {
  const input = quantity(usage.input, "input");
  const output = quantity(usage.output, "output");
  const cacheRead = quantity(usage.cacheRead, "cache-read");
  const cacheCreation = quantity(usage.cacheWrite, "cache-creation");
  quantity(usage.reasoning, "reasoning");
  const minimum =
    MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS[PI_MEMORY_PHASE2_MODEL];
  if (minimum === undefined) {
    throw new Error("Pi memory Phase 2 pricing threshold is missing");
  }
  const longContext = input + cacheRead + cacheCreation >= minimum;
  const category = (base: UsageCategoryBase): UsageCategory => {
    return longContext ? `${base}.long_context` : base;
  };
  return [
    { category: category("tokens.input"), quantity: input },
    { category: category("tokens.output"), quantity: output },
    { category: category("tokens.cache_read"), quantity: cacheRead },
    {
      category: category("tokens.cache_creation"),
      quantity: cacheCreation,
    },
  ].filter((entry) => {
    return entry.quantity > 0;
  });
}

function idempotencyKey(
  args: RecordPiMemoryPhase2UsageArgs,
  category: UsageCategory,
): string {
  return uuidv5(
    JSON.stringify([
      args.memoryStorageId,
      args.claimedRevision,
      args.selectionDigest,
      args.responseId,
      category,
    ]),
    PI_MEMORY_PHASE2_USAGE_NAMESPACE,
  );
}

/** Persist one terminal Phase 2 provider attempt outside foreground runs. */
export async function recordPiMemoryPhase2Usage(
  db: Db,
  args: RecordPiMemoryPhase2UsageArgs,
): Promise<void> {
  const expected = usageEntries(args.usage).map((entry) => {
    return {
      runId: null,
      idempotencyKey: idempotencyKey(args, entry.category),
      orgId: args.orgId,
      userId: args.userId,
      kind: "model",
      provider: PI_MEMORY_PHASE2_MODEL,
      category: entry.category,
      quantity: entry.quantity,
    } as const;
  });
  if (expected.length === 0) {
    return;
  }
  await db.transaction(async (tx) => {
    await tx
      .insert(usageEvent)
      .values(expected)
      .onConflictDoNothing({ target: [usageEvent.idempotencyKey] });
    const stored = await tx
      .select({
        idempotencyKey: usageEvent.idempotencyKey,
        runId: usageEvent.runId,
        orgId: usageEvent.orgId,
        userId: usageEvent.userId,
        kind: usageEvent.kind,
        provider: usageEvent.provider,
        category: usageEvent.category,
        quantity: usageEvent.quantity,
      })
      .from(usageEvent)
      .where(
        inArray(
          usageEvent.idempotencyKey,
          expected.map((row) => {
            return row.idempotencyKey;
          }),
        ),
      );
    const remaining = new Map(
      expected.map((row) => {
        return [row.idempotencyKey, row] as const;
      }),
    );
    for (const row of stored) {
      const wanted = remaining.get(row.idempotencyKey);
      if (
        !wanted ||
        row.runId !== null ||
        row.orgId !== wanted.orgId ||
        row.userId !== wanted.userId ||
        row.kind !== wanted.kind ||
        row.provider !== wanted.provider ||
        row.category !== wanted.category ||
        row.quantity !== wanted.quantity
      ) {
        throw new Error("Pi memory Phase 2 usage identity collision");
      }
      remaining.delete(row.idempotencyKey);
    }
    if (remaining.size > 0) {
      throw new Error("Pi memory Phase 2 usage persistence is incomplete");
    }
  });
}
