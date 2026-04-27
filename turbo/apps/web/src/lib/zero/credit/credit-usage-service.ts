import { clientCreditUsage } from "@vm0/db/schema/client-credit-usage";
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
 * Upsert client-reported credit usage records from an events webhook batch.
 *
 * Writes to `client_credit_usage` — the audit trail of client-reported
 * result events.  Billing itself is driven by the proxy-sourced
 * `credit_usage` table; this function does not touch billing fields.
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
      log.warn(
        "Result event missing uuid — deduplication disabled for this row",
        {
          runId,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        },
      );
    }

    await db
      .insert(clientCreditUsage)
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
        target: [clientCreditUsage.runId, clientCreditUsage.resultUuid],
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

    log.debug("Upserted client credit usage", {
      runId,
      resultUuid: result.uuid,
      model,
      hasTokenData: true,
    });
  }
}
