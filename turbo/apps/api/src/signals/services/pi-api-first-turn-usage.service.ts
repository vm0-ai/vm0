import { createHash } from "node:crypto";

import { MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS } from "@okouai/api-contracts/contracts/model-price-tiers";
import type { PiModelConfig } from "@okouai/api-contracts/contracts/runners";
import { usageEvent } from "@okouai/db/schema/usage-event";
import type { PiApiFirstTurnResult } from "@okouai/pi-agent-runtime/api";
import { inArray } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";

import type { Db } from "../external/db";

const PI_API_FIRST_TURN_USAGE_NAMESPACE =
  "26e1c547-485d-4438-bf6d-4b77959da0cb";
const TERRA_MODEL = "gpt-5.6-terra";

function terraLongContextMinimumInputTokens(): number {
  const minimum = MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS[TERRA_MODEL];
  if (minimum === undefined) {
    throw new Error("Terra long-context pricing threshold is missing");
  }
  return minimum;
}

const TERRA_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS =
  terraLongContextMinimumInputTokens();

type PiUsageCategoryBase =
  | "tokens.input"
  | "tokens.output"
  | "tokens.cache_read"
  | "tokens.cache_creation";
type PiUsageCategory =
  | PiUsageCategoryBase
  | `${PiUsageCategoryBase}.long_context`
  | `${PiUsageCategoryBase}.fast`
  | `${PiUsageCategoryBase}.long_context.fast`;

interface PiApiFirstTurnUsageEntry {
  readonly category: PiUsageCategory;
  readonly quantity: number;
}

interface RecordPiApiFirstTurnUsageArgs {
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly modelUsageProvider: string | undefined;
  readonly piProvider: PiModelConfig["provider"];
  readonly requestedServiceTier: PiModelConfig["serviceTier"];
  readonly turn: PiApiFirstTurnResult;
}

function usageQuantity(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Pi API first-turn ${field} usage is invalid`);
  }
  return value;
}

function sourceId(turn: PiApiFirstTurnResult): string {
  return (
    turn.assistantMessage.responseId ??
    createHash("sha256").update(turn.sessionJsonl).digest("hex")
  );
}

function idempotencyKey(namespace: string, parts: readonly string[]): string {
  return uuidv5(JSON.stringify(parts), namespace);
}

function piApiFirstTurnUsageEntries(
  turn: PiApiFirstTurnResult,
  fast: boolean,
): readonly PiApiFirstTurnUsageEntry[] {
  const usage = turn.assistantMessage.usage;
  const input = usageQuantity(usage.input, "input");
  const output = usageQuantity(usage.output, "output");
  const cacheRead = usageQuantity(usage.cacheRead, "cache-read");
  const cacheCreation = usageQuantity(usage.cacheWrite, "cache-creation");
  const longContext =
    input + cacheRead + cacheCreation >=
    TERRA_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS;
  const category = (base: PiUsageCategoryBase): PiUsageCategory => {
    if (longContext) {
      return fast ? `${base}.long_context.fast` : `${base}.long_context`;
    }
    return fast ? `${base}.fast` : base;
  };
  return (
    [
      { category: category("tokens.input"), quantity: input },
      { category: category("tokens.output"), quantity: output },
      { category: category("tokens.cache_read"), quantity: cacheRead },
      {
        category: category("tokens.cache_creation"),
        quantity: cacheCreation,
      },
    ] satisfies readonly {
      readonly category: PiUsageCategory;
      readonly quantity: number;
    }[]
  ).filter((entry) => {
    return entry.quantity > 0;
  });
}

function isFastPiApiFirstTurn(args: RecordPiApiFirstTurnUsageArgs): boolean {
  if (args.piProvider === "openrouter") {
    return (
      args.turn.observedServiceTier === "priority" ||
      args.turn.observedServiceTier === "fast"
    );
  }
  // Preserve direct OpenAI's accepted requested-tier billing contract.
  return args.requestedServiceTier === "priority";
}

/**
 * Persist API-owned Terra billing usage before any lifecycle commit. The
 * response identity keeps retries and late cancellation observers converged on
 * the same immutable ledger rows. Sandbox provider calls keep their independent
 * MITM-owned delivery identities.
 */
export async function recordPiApiFirstTurnUsage(
  db: Db,
  args: RecordPiApiFirstTurnUsageArgs,
): Promise<void> {
  if (args.modelUsageProvider !== TERRA_MODEL) {
    return;
  }
  const responseSourceId = sourceId(args.turn);
  const entries = piApiFirstTurnUsageEntries(
    args.turn,
    isFastPiApiFirstTurn(args),
  );
  const usageRows = entries.map((entry) => {
    return {
      runId: args.runId,
      idempotencyKey: idempotencyKey(PI_API_FIRST_TURN_USAGE_NAMESPACE, [
        args.runId,
        responseSourceId,
        entry.category,
      ]),
      orgId: args.orgId,
      userId: args.userId,
      kind: "model",
      provider: TERRA_MODEL,
      category: entry.category,
      quantity: entry.quantity,
    } as const;
  });
  if (usageRows.length === 0) {
    return;
  }
  await db.transaction(async (tx) => {
    await tx
      .insert(usageEvent)
      .values(usageRows)
      .onConflictDoNothing({ target: [usageEvent.idempotencyKey] });
    const storedUsageRows = await tx
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
          usageRows.map((row) => {
            return row.idempotencyKey;
          }),
        ),
      );
    const expectedByKey = new Map(
      usageRows.map((row) => {
        return [row.idempotencyKey, row] as const;
      }),
    );
    for (const row of storedUsageRows) {
      const expected = expectedByKey.get(row.idempotencyKey);
      if (
        !expected ||
        row.runId !== expected.runId ||
        row.orgId !== expected.orgId ||
        row.userId !== expected.userId ||
        row.kind !== expected.kind ||
        row.provider !== expected.provider ||
        row.category !== expected.category ||
        row.quantity !== expected.quantity
      ) {
        throw new Error("Pi API first-turn usage identity collision");
      }
      expectedByKey.delete(row.idempotencyKey);
    }
    if (expectedByKey.size > 0) {
      throw new Error("Pi API first-turn usage persistence is incomplete");
    }
  });
}
