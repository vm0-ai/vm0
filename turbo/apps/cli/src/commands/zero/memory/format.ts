import chalk from "chalk";
import type {
  MemoryContextResponse,
  MemoryRecallItem,
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
