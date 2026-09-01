import { createHash } from "node:crypto";

import { MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS } from "@okouai/api-contracts/contracts/model-price-tiers";
import { modelUsageObservation } from "@okouai/db/schema/model-usage-observation";
import { usageEvent } from "@okouai/db/schema/usage-event";
import type { PiApiFirstTurnResult } from "@okouai/pi-agent-runtime/api";
import { and, eq, inArray } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";

import type { Db } from "../external/db";

const PI_API_FIRST_TURN_USAGE_NAMESPACE =
  "26e1c547-485d-4438-bf6d-4b77959da0cb";
const PI_API_FIRST_TURN_OBSERVATION_NAMESPACE =
  "670e6ebc-79c3-4f44-b322-e26d1be7cf2e";
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
  | `${PiUsageCategoryBase}.long_context`;

interface PiApiFirstTurnUsageEntry {
  readonly category: PiUsageCategory;
  readonly quantity: number;
}

interface RecordPiApiFirstTurnUsageArgs {
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly modelUsageProvider: string | undefined;
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
): readonly PiApiFirstTurnUsageEntry[] {
  const usage = turn.assistantMessage.usage;
  const input = usageQuantity(usage.input, "input");
  const output = usageQuantity(usage.output, "output");
  const cacheRead = usageQuantity(usage.cacheRead, "cache-read");
  const cacheCreation = usageQuantity(usage.cacheWrite, "cache-creation");
  const longContext =
    input + cacheRead + cacheCreation >=
    TERRA_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS;
  const suffix = longContext ? ".long_context" : "";
  return (
    [
      { category: `tokens.input${suffix}`, quantity: input },
      { category: `tokens.output${suffix}`, quantity: output },
      { category: `tokens.cache_read${suffix}`, quantity: cacheRead },
      {
        category: `tokens.cache_creation${suffix}`,
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

function sameObservation(
  row: typeof modelUsageObservation.$inferSelect,
  expected: typeof modelUsageObservation.$inferInsert,
): boolean {
  return (
    row.model === expected.model &&
    row.inputTokens === expected.inputTokens &&
    row.outputTokens === expected.outputTokens &&
    row.cacheReadInputTokens === expected.cacheReadInputTokens &&
    row.cacheCreationInputTokens === expected.cacheCreationInputTokens
  );
}

/**
 * Persist API-owned Terra usage before any lifecycle commit. The response
 * identity owns both billing and public model observation rows, so retries and
 * late cancellation observers converge on the same immutable records. Sandbox
 * provider calls keep their independent MITM-owned delivery identities.
 */
export async function recordPiApiFirstTurnUsage(
  db: Db,
  args: RecordPiApiFirstTurnUsageArgs,
): Promise<void> {
  if (args.modelUsageProvider !== TERRA_MODEL) {
    return;
  }
  const responseSourceId = sourceId(args.turn);
  const entries = piApiFirstTurnUsageEntries(args.turn);
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
  const usage = args.turn.assistantMessage.usage;
  const observationRow = {
    idempotencyKey: idempotencyKey(PI_API_FIRST_TURN_OBSERVATION_NAMESPACE, [
      args.runId,
      responseSourceId,
    ]),
    model: TERRA_MODEL,
    inputTokens: usageQuantity(usage.input, "input"),
    outputTokens: usageQuantity(usage.output, "output"),
    cacheReadInputTokens: usageQuantity(usage.cacheRead, "cache-read"),
    cacheCreationInputTokens: usageQuantity(usage.cacheWrite, "cache-creation"),
  } as const;

  await db.transaction(async (tx) => {
    if (usageRows.length > 0) {
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
    }

    await tx
      .insert(modelUsageObservation)
      .values(observationRow)
      .onConflictDoNothing({
        target: [modelUsageObservation.idempotencyKey],
      });
    const [storedObservation] = await tx
      .select()
      .from(modelUsageObservation)
      .where(
        and(
          eq(
            modelUsageObservation.idempotencyKey,
            observationRow.idempotencyKey,
          ),
          eq(modelUsageObservation.model, TERRA_MODEL),
        ),
      )
      .limit(1);
    if (
      !storedObservation ||
      !sameObservation(storedObservation, observationRow)
    ) {
      throw new Error("Pi API first-turn observation identity collision");
    }
  });
}
