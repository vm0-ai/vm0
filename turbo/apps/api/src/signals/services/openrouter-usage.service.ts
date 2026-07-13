import { command } from "ccstate";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { and, eq, inArray } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";

import type { OpenRouterUsage } from "../external/openrouter";
import { writeDb$ } from "../external/db";
import { processOrgUsageEvents$ } from "./zero-credit-usage.service";

const OPENROUTER_USAGE_IDEMPOTENCY_NAMESPACE =
  "3cf6f344-d67b-4d96-ae5d-fd6c0d134b70";

const USAGE_KIND = "model";
const INPUT_CATEGORY = "tokens.input";
const CACHE_READ_CATEGORY = "tokens.cache_read";
const OUTPUT_CATEGORY = "tokens.output";
const OPENROUTER_USAGE_CATEGORIES = [
  INPUT_CATEGORY,
  CACHE_READ_CATEGORY,
  OUTPUT_CATEGORY,
] as const;

interface OpenRouterUsageEntry {
  readonly category: string;
  readonly quantity: number;
}

interface RecordOpenRouterUsageArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string | undefined;
  readonly provider: string;
  readonly operation: string;
  readonly operationId: string;
  readonly usage: OpenRouterUsage | undefined;
}

function positiveInteger(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function usageEntries(
  usage: OpenRouterUsage | undefined,
): OpenRouterUsageEntry[] {
  if (!usage) {
    return [];
  }

  const promptTokens = positiveInteger(usage.prompt_tokens);
  const cachedTokens = Math.min(
    promptTokens,
    positiveInteger(usage.prompt_tokens_details?.cached_tokens),
  );
  const inputTokens = promptTokens - cachedTokens;
  const outputTokens = positiveInteger(usage.completion_tokens);

  return [
    { category: INPUT_CATEGORY, quantity: inputTokens },
    { category: CACHE_READ_CATEGORY, quantity: cachedTokens },
    { category: OUTPUT_CATEGORY, quantity: outputTokens },
  ].filter((entry) => {
    return entry.quantity > 0;
  });
}

function usageIdempotencyKey(args: {
  readonly operation: string;
  readonly operationId: string;
  readonly provider: string;
  readonly category: string;
}): string {
  return uuidv5(
    `${args.operation}:${args.operationId}:${args.provider}:${args.category}`,
    OPENROUTER_USAGE_IDEMPOTENCY_NAMESPACE,
  );
}

export const checkOpenRouterUsagePricing$ = command(
  async (
    { set },
    args: { readonly provider: string },
    signal: AbortSignal,
  ): Promise<readonly string[]> => {
    const writeDb = set(writeDb$);
    const rows = await writeDb
      .select({ category: usagePricing.category })
      .from(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, USAGE_KIND),
          eq(usagePricing.provider, args.provider),
          inArray(usagePricing.category, [...OPENROUTER_USAGE_CATEGORIES]),
        ),
      );
    signal.throwIfAborted();

    const present = new Set(
      rows.map((row) => {
        return row.category;
      }),
    );
    return OPENROUTER_USAGE_CATEGORIES.filter((category) => {
      return !present.has(category);
    });
  },
);

export const recordOpenRouterUsage$ = command(
  async (
    { set },
    args: RecordOpenRouterUsageArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const entries = usageEntries(args.usage);
    if (entries.length === 0) {
      return;
    }

    const writeDb = set(writeDb$);
    await writeDb
      .insert(usageEvent)
      .values(
        entries.map((entry) => {
          return {
            runId: args.runId ?? null,
            idempotencyKey: usageIdempotencyKey({
              operation: args.operation,
              operationId: args.operationId,
              provider: args.provider,
              category: entry.category,
            }),
            orgId: args.orgId,
            userId: args.userId,
            kind: USAGE_KIND,
            provider: args.provider,
            category: entry.category,
            quantity: entry.quantity,
          };
        }),
      )
      .onConflictDoNothing({ target: [usageEvent.idempotencyKey] });
    signal.throwIfAborted();

    await set(processOrgUsageEvents$, args.orgId, signal);
    signal.throwIfAborted();
  },
);
