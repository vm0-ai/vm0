import { zeroWorkflowAutomationMemoryEmbeddings } from "@vm0/db/schema/zero-workflow";
import { eq } from "drizzle-orm";

import { logger } from "../../lib/log";
import type { Db } from "../external/db";
import { settle } from "../utils";
import {
  embedZeroMemoryText,
  isValidMemoryEmbedding,
  type LoadedMemoryEmbedding,
  type MemoryEmbeddingCacheResult,
  memoryEmbeddingContentHash,
  zeroMemoryEmbeddingModel,
} from "./zero-memory-embedding.service";

const log = logger("zero-workflow-automation-memory-embedding");

function cacheMissResult(args: {
  readonly row:
    | {
        readonly embeddingModel: string;
        readonly queryHash: string;
        readonly embedding: readonly number[];
      }
    | undefined;
  readonly model: string;
  readonly queryHash: string;
}): MemoryEmbeddingCacheResult {
  if (!args.row) {
    return "miss_absent";
  }
  if (args.row.embeddingModel !== args.model) {
    return "miss_model_changed";
  }
  if (args.row.queryHash !== args.queryHash) {
    return "miss_query_changed";
  }
  return "miss_invalid";
}

export async function loadWorkflowAutomationMemoryEmbedding(
  db: Db,
  args: {
    readonly workflowAutomationId: string;
    readonly query: string;
  },
): Promise<LoadedMemoryEmbedding> {
  const model = zeroMemoryEmbeddingModel();
  const queryHash = memoryEmbeddingContentHash({ model, text: args.query });
  const loaded = await settle(
    db
      .select({
        embeddingModel: zeroWorkflowAutomationMemoryEmbeddings.embeddingModel,
        queryHash: zeroWorkflowAutomationMemoryEmbeddings.queryHash,
        embedding: zeroWorkflowAutomationMemoryEmbeddings.embedding,
      })
      .from(zeroWorkflowAutomationMemoryEmbeddings)
      .where(
        eq(
          zeroWorkflowAutomationMemoryEmbeddings.workflowAutomationId,
          args.workflowAutomationId,
        ),
      )
      .limit(1),
  );

  let cacheResult: MemoryEmbeddingCacheResult;
  if (!loaded.ok) {
    log.warn("Failed to read workflow automation memory embedding cache");
    cacheResult = "miss_read_failed";
  } else {
    const row = loaded.value[0];
    if (
      row?.embeddingModel === model &&
      row.queryHash === queryHash &&
      isValidMemoryEmbedding(row.embedding)
    ) {
      return {
        embedding: { model: row.embeddingModel, embedding: row.embedding },
        cacheResult: "hit",
      };
    }
    cacheResult = cacheMissResult({ row, model, queryHash });
  }

  const embeddingResult = await settle(embedZeroMemoryText(args.query));
  if (!embeddingResult.ok) {
    log.warn("Failed to embed workflow automation memory query");
    return { embedding: null, cacheResult };
  }
  const embedded = embeddingResult.value;
  if (!embedded) {
    return { embedding: null, cacheResult };
  }
  const embeddedQueryHash = memoryEmbeddingContentHash({
    model: embedded.model,
    text: args.query,
  });
  const persisted = await settle(
    db
      .insert(zeroWorkflowAutomationMemoryEmbeddings)
      .values({
        workflowAutomationId: args.workflowAutomationId,
        embeddingModel: embedded.model,
        queryHash: embeddedQueryHash,
        embedding: [...embedded.embedding],
      })
      .onConflictDoUpdate({
        target: zeroWorkflowAutomationMemoryEmbeddings.workflowAutomationId,
        set: {
          embeddingModel: embedded.model,
          queryHash: embeddedQueryHash,
          embedding: [...embedded.embedding],
        },
      }),
  );
  if (!persisted.ok) {
    log.warn("Failed to persist workflow automation memory embedding cache");
    cacheResult = "miss_write_failed";
  }

  return { embedding: embedded, cacheResult };
}
