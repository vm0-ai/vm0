import { createHash } from "node:crypto";

import { z } from "zod";

import { env, optionalEnv } from "../../lib/env";

const ZERO_MEMORY_EMBEDDING_DIMENSIONS = 1536;
const ZERO_MEMORY_EMBEDDING_MODEL =
  optionalEnv("ZERO_MEMORY_EMBEDDING_MODEL") ?? "text-embedding-3-small";

const openAiEmbeddingResponseSchema = z.object({
  data: z
    .array(
      z.object({
        embedding: z.array(z.number()),
      }),
    )
    .min(1),
});

interface MemoryEmbeddingResult {
  readonly model: string;
  readonly embedding: readonly number[];
}

function assertEmbeddingDimensions(embedding: readonly number[]): void {
  if (embedding.length !== ZERO_MEMORY_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Expected ${ZERO_MEMORY_EMBEDDING_DIMENSIONS} memory embedding dimensions, received ${embedding.length}`,
    );
  }
  for (const value of embedding) {
    if (!Number.isFinite(value)) {
      throw new Error("Memory embedding contains a non-finite value");
    }
  }
}

function deterministicUnitVector(seed: string): readonly number[] {
  const values: number[] = [];
  let block = 0;
  while (values.length < ZERO_MEMORY_EMBEDDING_DIMENSIONS) {
    const digest = createHash("sha256").update(`${seed}:${block}`).digest();
    for (const byte of digest) {
      values.push(byte / 127.5 - 1);
      if (values.length === ZERO_MEMORY_EMBEDDING_DIMENSIONS) {
        break;
      }
    }
    block += 1;
  }

  const magnitude = Math.sqrt(
    values.reduce((sum, value) => {
      return sum + value * value;
    }, 0),
  );
  return values.map((value) => {
    return value / magnitude;
  });
}

export function createDeterministicMemoryEmbeddingForTest(
  text: string,
): readonly number[] {
  return deterministicUnitVector(text.trim().toLowerCase());
}

export function memoryEmbeddingContentHash(args: {
  readonly model: string;
  readonly text: string;
}): string {
  return createHash("sha256")
    .update(args.model)
    .update("\0")
    .update(args.text)
    .digest("hex");
}

export function memoryEmbeddingSqlLiteral(
  embedding: readonly number[],
): string {
  assertEmbeddingDimensions(embedding);
  return `[${embedding.join(",")}]`;
}

function shouldUseDeterministicTestEmbeddings(): boolean {
  return optionalEnv("ZERO_MEMORY_EMBEDDING_PROVIDER") === "test";
}

function shouldCallOpenAiEmbeddingApi(): boolean {
  if (shouldUseDeterministicTestEmbeddings()) {
    return false;
  }
  return env("VITEST") !== "true";
}

export async function embedZeroMemoryText(
  text: string,
): Promise<MemoryEmbeddingResult | null> {
  const input = text.trim();
  if (input.length === 0) {
    return null;
  }

  if (shouldUseDeterministicTestEmbeddings()) {
    return {
      model: "test-deterministic-embedding",
      embedding: createDeterministicMemoryEmbeddingForTest(input),
    };
  }

  if (!shouldCallOpenAiEmbeddingApi()) {
    return null;
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env("OPENAI_API_KEY")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ZERO_MEMORY_EMBEDDING_MODEL,
      input,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `OpenAI embeddings request failed with ${response.status}: ${body}`,
    );
  }

  const parsed = openAiEmbeddingResponseSchema.parse(await response.json());
  const embedding = parsed.data[0]?.embedding;
  if (!embedding) {
    throw new Error("OpenAI embeddings response did not include an embedding");
  }
  assertEmbeddingDimensions(embedding);
  return { model: ZERO_MEMORY_EMBEDDING_MODEL, embedding };
}
