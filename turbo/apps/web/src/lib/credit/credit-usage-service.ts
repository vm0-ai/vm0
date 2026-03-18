import { sql } from "drizzle-orm";
import { creditUsage } from "../../db/schema/credit-usage";
import { logger } from "../logger";

const log = logger("service:credit-usage");

interface EventData {
  type: string;
  subtype?: string;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
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
): Promise<void> {
  const db = globalThis.services.db;

  // Extract model from system init event (if present)
  let model: string | undefined;
  for (const event of events) {
    if (event.type === "system" && event.subtype === "init" && event.model) {
      model = String(event.model);
      break;
    }
  }

  // Extract token usage from result event (if present)
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  for (const event of events) {
    if (event.type === "result" && event.usage) {
      inputTokens = event.usage.input_tokens ?? 0;
      outputTokens = event.usage.output_tokens ?? 0;
      break;
    }
  }

  await db
    .insert(creditUsage)
    .values({
      runId,
      orgId,
      userId,
      model: model ?? "unknown",
      numEvents: events.length,
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
    })
    .onConflictDoUpdate({
      target: creditUsage.runId,
      set: {
        numEvents: sql`${creditUsage.numEvents} + ${events.length}`,
        ...(model !== undefined ? { model } : {}),
        ...(inputTokens !== undefined
          ? { inputTokens, outputTokens: outputTokens ?? 0 }
          : {}),
      },
    });

  log.debug("Upserted credit usage", {
    runId,
    numEvents: events.length,
    model: model ?? "unchanged",
    hasTokenData: inputTokens !== undefined,
  });
}
