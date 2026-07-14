import { threadGoalMemoryEmbeddings } from "@vm0/db/schema/thread-goal";
import { eq } from "drizzle-orm";

import { logger } from "../../lib/log";
import type { Db } from "../external/db";
import { tapError } from "../utils";
import {
  embedZeroMemoryText,
  isValidMemoryEmbedding,
  type LoadedMemoryEmbedding,
  type MemoryEmbeddingCacheResult,
  memoryEmbeddingContentHash,
  zeroMemoryEmbeddingModel,
} from "./zero-memory-embedding.service";

const log = logger("zero-goal-memory-embedding");

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

export async function loadGoalMemoryEmbedding(
  db: Db,
  args: {
    readonly goalId: string;
    readonly query: string;
  },
): Promise<LoadedMemoryEmbedding> {
  const model = zeroMemoryEmbeddingModel();
  const queryHash = memoryEmbeddingContentHash({ model, text: args.query });
  const loaded = await tapError(
    db
      .select({
        embeddingModel: threadGoalMemoryEmbeddings.embeddingModel,
        queryHash: threadGoalMemoryEmbeddings.queryHash,
        embedding: threadGoalMemoryEmbeddings.embedding,
      })
      .from(threadGoalMemoryEmbeddings)
      .where(eq(threadGoalMemoryEmbeddings.goalId, args.goalId))
      .limit(1),
    () => {
      log.warn("Failed to read goal memory embedding cache");
    },
  );

  let cacheResult: MemoryEmbeddingCacheResult;
  if (!loaded) {
    cacheResult = "miss_read_failed";
  } else {
    const row = loaded[0];
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

  const embedded = await tapError(embedZeroMemoryText(args.query), () => {
    log.warn("Failed to embed goal memory query");
  });
  if (embedded === undefined) {
    return { embedding: null, cacheResult };
  }
  if (!embedded) {
    return { embedding: null, cacheResult };
  }
  const embeddedQueryHash = memoryEmbeddingContentHash({
    model: embedded.model,
    text: args.query,
  });

  await tapError(
    db
      .insert(threadGoalMemoryEmbeddings)
      .values({
        goalId: args.goalId,
        embeddingModel: embedded.model,
        queryHash: embeddedQueryHash,
        embedding: [...embedded.embedding],
      })
      .onConflictDoUpdate({
        target: threadGoalMemoryEmbeddings.goalId,
        set: {
          embeddingModel: embedded.model,
          queryHash: embeddedQueryHash,
          embedding: [...embedded.embedding],
        },
      }),
    () => {
      log.warn("Failed to persist goal memory embedding cache");
      cacheResult = "miss_write_failed";
    },
  );

  return { embedding: embedded, cacheResult };
}
