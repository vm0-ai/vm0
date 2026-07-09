import chalk from "chalk";
import type {
  MemoryContextResponse,
  MemoryDocumentListResponse,
  MemoryForgetResponse,
  MemoryHistoryResponse,
  MemoryLifecycleMemory,
  MemoryListResponse,
  MemoryRecallItem,
  MemorySearchResponse,
  MemorySearchResult,
  MemoryTombstoneListResponse,
} from "@vm0/api-contracts/contracts/zero-memory";

function formatDate(value: string | null): string {
  if (!value) {
    return "unknown";
  }
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function formatKind(kind: MemoryRecallItem["kind"]): string {
  switch (kind) {
    case "key_fact": {
      return "key fact";
    }
    case "open_loop": {
      return "open loop";
    }
    case "preference": {
      return "preference";
    }
  }
}

function sourceSummary(memory: MemoryRecallItem): string {
  const source = memory.sources[0];
  if (!source) {
    return "no source";
  }
  return `${source.provider}:${source.externalId} (${formatDate(source.occurredAt)})`;
}

export function printMemoryRecall(memories: readonly MemoryRecallItem[]): void {
  if (memories.length === 0) {
    console.log("No memories found");
    console.log(
      chalk.dim(
        '  Try a broader query, for example: zero memory recall "pricing"',
      ),
    );
    return;
  }

  console.log(chalk.green(`✓ Recalled ${memories.length} memories`));
  for (const memory of memories) {
    const entity = memory.relationship.entity.displayName;
    console.log(`- ${memory.text}`);
    console.log(
      chalk.dim(
        `  ${formatKind(memory.kind)} · ${entity} · confidence ${memory.confidence} · ${sourceSummary(memory)}`,
      ),
    );
  }
}

export function printMemoryContext(response: MemoryContextResponse): void {
  if (response.context.length === 0) {
    console.log("No memory context found");
    console.log(
      chalk.dim('  Try: zero memory context --query "customer follow up"'),
    );
    return;
  }

  console.log(response.context);
}

function compactText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 180) {
    return normalized;
  }
  return `${normalized.slice(0, 177)}...`;
}

function formatScore(score: number): string {
  return score.toFixed(2);
}

function printMemorySearchResult(result: MemorySearchResult): void {
  if (result.kind === "memory") {
    const memory = result.memory;
    const entity = memory.relationship.entity.displayName;
    console.log(`- ${memory.text}`);
    console.log(
      chalk.dim(
        `  memory · ${formatKind(memory.kind)} · ${entity} · score ${formatScore(result.score)} · ${sourceSummary(memory)}`,
      ),
    );
    return;
  }

  const title = result.title ?? result.externalId;
  const citationUrl = result.citation.url ? ` · ${result.citation.url}` : "";
  console.log(`- ${title}`);
  console.log(chalk.dim(`  document · ${compactText(result.text)}`));
  console.log(
    chalk.dim(
      `  ${result.provider}:${result.externalId} · ${result.contextSpace.displayName} · score ${formatScore(result.score)}${citationUrl}`,
    ),
  );
}

export function printMemorySearch(response: MemorySearchResponse): void {
  if (response.results.length === 0) {
    console.log("No memory or document results found");
    console.log(
      chalk.dim('  Try: zero memory search "security review" --mode hybrid'),
    );
    return;
  }

  console.log(
    chalk.green(
      `✓ Found ${response.results.length} ${response.mode} memory results`,
    ),
  );
  for (const result of response.results) {
    printMemorySearchResult(result);
  }
}

function contextSpaceSummary(memory: MemoryLifecycleMemory): string {
  return memory.contextSpace
    ? `${memory.contextSpace.type}:${memory.contextSpace.key}`
    : "no context space";
}

function printLifecycleMemory(memory: MemoryLifecycleMemory): void {
  console.log(`- ${memory.text}`);
  console.log(
    chalk.dim(
      `  ${memory.kind} · ${memory.status} · confidence ${memory.confidence} · ${contextSpaceSummary(memory)} · ${memory.id}`,
    ),
  );
}

export function printMemoryList(response: MemoryListResponse): void {
  if (response.memories.length === 0) {
    console.log("No lifecycle memories found");
    console.log(
      chalk.dim('  Create one: zero memory create "Remember this fact"'),
    );
    return;
  }
  console.log(chalk.green(`✓ Found ${response.memories.length} memories`));
  for (const memory of response.memories) {
    printLifecycleMemory(memory);
  }
}

export function printMemoryCreated(memory: MemoryLifecycleMemory): void {
  console.log(chalk.green("✓ Memory created"));
  printLifecycleMemory(memory);
  console.log(chalk.dim(`  History: zero memory history memory ${memory.id}`));
}

export function printMemoryUpdated(memory: MemoryLifecycleMemory): void {
  console.log(chalk.green("✓ Memory updated"));
  printLifecycleMemory(memory);
  console.log(chalk.dim(`  History: zero memory history memory ${memory.id}`));
}

export function printMemoryForget(response: MemoryForgetResponse): void {
  if (response.forgotten.length === 0) {
    console.log("No matching active memory or document found");
    console.log(chalk.dim('  Try: zero memory search "the thing to forget"'));
    return;
  }
  console.log(
    chalk.green(`✓ Recorded ${response.forgotten.length} tombstones`),
  );
  for (const tombstone of response.forgotten) {
    console.log(
      `- ${tombstone.targetKind}: ${tombstone.targetTitle ?? tombstone.targetText ?? tombstone.fingerprint}`,
    );
    console.log(chalk.dim(`  ${tombstone.fingerprint} · ${tombstone.id}`));
  }
}

export function printMemoryHistory(response: MemoryHistoryResponse): void {
  if (response.history.length === 0) {
    console.log("No memory history found");
    return;
  }
  console.log(chalk.green(`✓ Found ${response.history.length} versions`));
  for (const version of response.history) {
    console.log(
      `- v${version.version} ${version.operation ?? "change"} ${formatDate(
        version.createdAt,
      )}`,
    );
    console.log(
      chalk.dim(
        `  ${version.targetKind}:${version.targetId} · ${version.contentHash}`,
      ),
    );
    if (version.text ?? version.title) {
      console.log(
        chalk.dim(`  ${compactText(version.text ?? version.title ?? "")}`),
      );
    }
  }
}

export function printMemoryDocuments(
  response: MemoryDocumentListResponse,
): void {
  if (response.documents.length === 0) {
    console.log("No memory documents found");
    console.log(chalk.dim("  Backfill GitHub or Notion memory sources first"));
    return;
  }
  console.log(chalk.green(`✓ Found ${response.documents.length} documents`));
  for (const document of response.documents) {
    console.log(`- ${document.title ?? document.externalId}`);
    console.log(
      chalk.dim(
        `  ${document.provider}:${document.externalId} · ${document.status} · ${document.chunkCount} chunks · ${document.id}`,
      ),
    );
  }
}

export function printMemoryForgotten(
  response: MemoryTombstoneListResponse,
): void {
  if (response.forgotten.length === 0) {
    console.log("No forgotten memory records found");
    return;
  }
  console.log(chalk.green(`✓ Found ${response.forgotten.length} tombstones`));
  for (const tombstone of response.forgotten) {
    console.log(
      `- ${tombstone.targetKind}: ${tombstone.targetTitle ?? tombstone.targetText ?? tombstone.fingerprint}`,
    );
    console.log(
      chalk.dim(`  ${tombstone.fingerprint} · ${tombstone.createdAt}`),
    );
  }
}
