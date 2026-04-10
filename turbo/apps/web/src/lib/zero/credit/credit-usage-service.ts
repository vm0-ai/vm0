import { creditUsage } from "../../../db/schema/credit-usage";
import { logger } from "../../shared/logger";

const log = logger("service:credit-usage");

interface EventData {
  type: string;
  subtype?: string;
  model?: string;
  uuid?: string;
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

interface ResultEventData {
  uuid: string | undefined;
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

function extractAllResults(events: EventData[]): ResultEventData[] {
  return events
    .filter((e) => {
      return e.type === "result";
    })
    .map((e) => {
      return {
        uuid: e.uuid,
        inputTokens: e.usage?.input_tokens ?? 0,
        outputTokens: e.usage?.output_tokens ?? 0,
        cacheReadInputTokens: e.usage?.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: e.usage?.cache_creation_input_tokens ?? 0,
        webSearchRequests: e.usage?.server_tool_use?.web_search_requests ?? 0,
        costUsd:
          e.total_cost_usd !== undefined ? String(e.total_cost_usd) : null,
      };
    });
}

/**
 * Upsert credit_usage records from an events webhook batch.
 *
 * - Only creates rows for result events (one row per result)
 * - Each row is keyed by (runId, resultUuid) for deduplication
 * - Scans events for system init event to extract model
 * - On conflict (same runId + resultUuid), updates token data (idempotent for retries)
 */
export async function upsertCreditUsage(
  runId: string,
  orgId: string,
  userId: string,
  events: EventData[],
  modelProvider?: string,
  selectedModel?: string,
): Promise<void> {
  const db = globalThis.services.db;

  const results = extractAllResults(events);
  if (results.length === 0) {
    return;
  }

  const model = selectedModel ?? extractModel(events) ?? "unknown";

  for (const result of results) {
    if (!result.uuid) {
      log.error(
        "Result event missing uuid — deduplication disabled for this row",
        {
          runId,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        },
      );
    }

    await db
      .insert(creditUsage)
      .values({
        runId,
        resultUuid: result.uuid ?? null,
        orgId,
        userId,
        model,
        modelProvider: modelProvider ?? "",
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadInputTokens: result.cacheReadInputTokens,
        cacheCreationInputTokens: result.cacheCreationInputTokens,
        webSearchRequests: result.webSearchRequests,
        costUsd: result.costUsd,
      })
      .onConflictDoUpdate({
        target: [creditUsage.runId, creditUsage.resultUuid],
        set: {
          model,
          modelProvider: modelProvider ?? "",
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheReadInputTokens: result.cacheReadInputTokens,
          cacheCreationInputTokens: result.cacheCreationInputTokens,
          webSearchRequests: result.webSearchRequests,
          costUsd: result.costUsd,
        },
      });

    log.debug("Upserted credit usage", {
      runId,
      resultUuid: result.uuid,
      model,
      hasTokenData: true,
    });
  }
}
