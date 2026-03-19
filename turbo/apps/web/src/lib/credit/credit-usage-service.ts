import { sql } from "drizzle-orm";
import { creditUsage } from "../../db/schema/credit-usage";
import { logger } from "../logger";

const log = logger("service:credit-usage");

interface EventData {
  type: string;
  subtype?: string;
  model?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    server_tool_use?: {
      web_search_requests?: number;
    };
  };
}

interface ResultData {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUsd: string | null;
}

function extractModel(events: EventData[]): string | undefined {
  for (const event of events) {
    if (event.type === "system" && event.subtype === "init" && event.model) {
      return String(event.model);
    }
  }
  return undefined;
}

function extractResultData(events: EventData[]): ResultData | undefined {
  for (const event of events) {
    if (event.type === "result") {
      return {
        inputTokens: event.usage?.input_tokens ?? 0,
        outputTokens: event.usage?.output_tokens ?? 0,
        cacheReadInputTokens: event.usage?.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: event.usage?.cache_creation_input_tokens ?? 0,
        webSearchRequests:
          event.usage?.server_tool_use?.web_search_requests ?? 0,
        costUsd:
          event.total_cost_usd !== undefined
            ? String(event.total_cost_usd)
            : null,
      };
    }
  }
  return undefined;
}

/**
 * Upsert a credit_usage record from an events webhook batch.
 *
 * - Scans events for system init event to extract model
 * - Scans events for result event to extract token usage
 * - Inserts or updates the credit_usage row keyed by runId
 * - Increments numEvents by the batch size on each call
 */
export async function upsertCreditUsage(
  runId: string,
  orgId: string,
  userId: string,
  events: EventData[],
  modelProvider?: string,
): Promise<void> {
  const db = globalThis.services.db;

  const model = extractModel(events);
  const result = extractResultData(events);

  await db
    .insert(creditUsage)
    .values({
      runId,
      orgId,
      userId,
      model: model ?? "unknown",
      modelProvider: modelProvider ?? "",
      numEvents: events.length,
      inputTokens: result?.inputTokens ?? 0,
      outputTokens: result?.outputTokens ?? 0,
      cacheReadInputTokens: result?.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: result?.cacheCreationInputTokens ?? 0,
      webSearchRequests: result?.webSearchRequests ?? 0,
      costUsd: result?.costUsd ?? null,
    })
    .onConflictDoUpdate({
      target: creditUsage.runId,
      set: {
        numEvents: sql`${creditUsage.numEvents} + ${events.length}`,
        ...(model !== undefined ? { model } : {}),
        ...(modelProvider !== undefined ? { modelProvider } : {}),
        ...(result !== undefined
          ? {
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              cacheReadInputTokens: result.cacheReadInputTokens,
              cacheCreationInputTokens: result.cacheCreationInputTokens,
              webSearchRequests: result.webSearchRequests,
              costUsd: result.costUsd,
            }
          : {}),
      },
    });

  log.debug("Upserted credit usage", {
    runId,
    numEvents: events.length,
    model: model ?? "unchanged",
    hasTokenData: result !== undefined,
  });
}
