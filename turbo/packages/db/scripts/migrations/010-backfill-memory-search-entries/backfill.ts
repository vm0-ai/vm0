#!/usr/bin/env tsx

/**
 * Backfill pgvector search entries for structured memory.
 *
 * Usage (from turbo/packages/db):
 *   pnpm exec tsx scripts/migrations/010-backfill-memory-search-entries/backfill.ts
 *   pnpm exec tsx scripts/migrations/010-backfill-memory-search-entries/backfill.ts --migrate
 *
 * Environment:
 *   DATABASE_URL — Required
 *   OPENAI_API_KEY — Required when --migrate is passed
 *   ZERO_MEMORY_EMBEDDING_MODEL — Optional, defaults to text-embedding-3-small
 */

import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import postgres from "postgres";

const EMBEDDING_DIMENSIONS = 1536;
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const BATCH_SIZE = 64;

const { values: args } = parseArgs({
  options: {
    migrate: { type: "boolean", default: false },
  },
  strict: true,
});

const DRY_RUN = !args.migrate;

interface MemoryRow {
  readonly id: string;
  readonly org_id: string;
  readonly user_id: string;
  readonly entity_id: string | null;
  readonly kind: string;
  readonly status: string;
  readonly text: string;
  readonly confidence: number;
  readonly last_seen_at: Date;
  readonly display_name: string | null;
}

interface OpenAiEmbeddingResponse {
  readonly data: readonly {
    readonly index: number;
    readonly embedding: readonly number[];
  }[];
}

function memorySearchText(row: MemoryRow): string {
  const lines = [row.text.trim(), `Kind: ${row.kind}`];
  if (row.display_name) {
    lines.push(`Entity: ${row.display_name}`);
  }
  return lines.join("\n");
}

function contentHash(args: { readonly model: string; readonly text: string }) {
  return createHash("sha256")
    .update(args.model)
    .update("\0")
    .update(args.text)
    .digest("hex");
}

function embeddingLiteral(embedding: readonly number[]): string {
  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Expected ${EMBEDDING_DIMENSIONS} embedding dimensions, received ${embedding.length}`,
    );
  }
  for (const value of embedding) {
    if (!Number.isFinite(value)) {
      throw new Error("Embedding contains a non-finite value");
    }
  }
  return `[${embedding.join(",")}]`;
}

async function countCandidates(sql: postgres.Sql): Promise<number> {
  const rows = await sql`
    SELECT COUNT(*)::int AS candidate_count
    FROM memories m
    WHERE m.status = 'active'
  `;
  return Number(rows[0]?.candidate_count ?? 0);
}

async function loadBatch(
  sql: postgres.Sql,
  offset: number,
): Promise<readonly MemoryRow[]> {
  const rows = await sql<MemoryRow[]>`
    SELECT
      m.id,
      m.org_id,
      m.user_id,
      m.entity_id,
      m.kind,
      m.status,
      m.text,
      m.confidence,
      m.last_seen_at,
      e.display_name
    FROM memories m
    LEFT JOIN memory_entities e ON e.id = m.entity_id
    WHERE m.status = 'active'
    ORDER BY m.updated_at, m.id
    LIMIT ${BATCH_SIZE}
    OFFSET ${offset}
  `;
  return rows;
}

async function embedBatch(
  texts: readonly string[],
  model: string,
): Promise<readonly (readonly number[])[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required when --migrate is passed");
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: texts,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `OpenAI embeddings request failed with ${response.status}: ${body}`,
    );
  }

  const parsed = (await response.json()) as OpenAiEmbeddingResponse;
  return [...parsed.data]
    .sort((left, right) => {
      return left.index - right.index;
    })
    .map((item) => {
      return item.embedding;
    });
}

async function upsertEntries(
  sql: postgres.Sql,
  rows: readonly MemoryRow[],
  embeddings: readonly (readonly number[])[],
  model: string,
): Promise<void> {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const embedding = embeddings[index];
    if (!row || !embedding) {
      throw new Error("Embedding response did not match requested batch size");
    }
    const text = memorySearchText(row);
    await sql`
      INSERT INTO memory_search_entries (
        org_id,
        user_id,
        memory_id,
        entity_id,
        entry_kind,
        memory_kind,
        status,
        text,
        embedding,
        embedding_model,
        content_hash,
        confidence,
        last_seen_at,
        created_at,
        updated_at
      )
      VALUES (
        ${row.org_id},
        ${row.user_id},
        ${row.id},
        ${row.entity_id},
        'memory_text',
        ${row.kind},
        ${row.status},
        ${text},
        ${embeddingLiteral(embedding)}::vector,
        ${model},
        ${contentHash({ model, text })},
        ${row.confidence},
        ${row.last_seen_at},
        NOW(),
        NOW()
      )
      ON CONFLICT (memory_id, entry_kind, embedding_model)
      DO UPDATE SET
        entity_id = EXCLUDED.entity_id,
        memory_kind = EXCLUDED.memory_kind,
        status = EXCLUDED.status,
        text = EXCLUDED.text,
        embedding = EXCLUDED.embedding,
        content_hash = EXCLUDED.content_hash,
        confidence = EXCLUDED.confidence,
        last_seen_at = EXCLUDED.last_seen_at,
        updated_at = NOW()
      WHERE memory_search_entries.content_hash <> EXCLUDED.content_hash
        OR memory_search_entries.status <> EXCLUDED.status
        OR memory_search_entries.confidence <> EXCLUDED.confidence
        OR memory_search_entries.last_seen_at <> EXCLUDED.last_seen_at
    `;
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const model =
    process.env.ZERO_MEMORY_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;

  const sql = postgres(databaseUrl, { max: 1 });

  try {
    console.log("=== Backfill Memory Search Entries ===");
    console.log(
      `Mode: ${DRY_RUN ? "dry-run (pass --migrate to execute)" : "MIGRATE"}`,
    );
    console.log(`Embedding model: ${model}`);

    const candidateCount = await countCandidates(sql);
    console.log(`Candidate active memory row(s): ${candidateCount}`);

    if (DRY_RUN || candidateCount === 0) {
      return;
    }

    let processedCount = 0;
    for (let offset = 0; offset < candidateCount; offset += BATCH_SIZE) {
      const rows = await loadBatch(sql, offset);
      const texts = rows.map(memorySearchText);
      const embeddings = await embedBatch(texts, model);
      await upsertEntries(sql, rows, embeddings, model);
      processedCount += rows.length;
      console.log(`Backfilled ${processedCount}/${candidateCount}`);
    }
  } finally {
    await sql.end();
  }
}

await main();
