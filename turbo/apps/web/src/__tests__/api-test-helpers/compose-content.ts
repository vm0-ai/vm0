import { createHash } from "node:crypto";
import type { agentComposeApiContentSchema } from "@vm0/api-contracts/contracts/composes";
import type { z } from "zod";

export type TestAgentComposeContent = z.infer<
  typeof agentComposeApiContentSchema
>;
export type TestAgentDefinition = TestAgentComposeContent["agents"][string];

function sortObjectKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }

  const sorted: Record<string, unknown> = {};
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  for (const key of keys) {
    sorted[key] = sortObjectKeys(record[key]);
  }
  return sorted;
}

export function computeTestComposeVersionId(
  content: TestAgentComposeContent,
): string {
  const canonical = JSON.stringify(sortObjectKeys(content));
  return createHash("sha256").update(canonical).digest("hex");
}
