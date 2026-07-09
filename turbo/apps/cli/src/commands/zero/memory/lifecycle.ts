import chalk from "chalk";
import { Command } from "commander";
import type {
  MemoryKind,
  MemorySourceProvider,
} from "@vm0/api-contracts/contracts/zero-memory";

import {
  createZeroMemory,
  forgetZeroMemory,
  forgetZeroMemoryByPrompt,
  listZeroMemory,
  listZeroMemoryDocuments,
  listZeroMemoryForgotten,
  listZeroMemoryHistory,
  updateZeroMemory,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import {
  printMemoryCreated,
  printMemoryDocuments,
  printMemoryForget,
  printMemoryForgotten,
  printMemoryHistory,
  printMemoryList,
  printMemoryUpdated,
} from "./format";

interface JsonOption {
  readonly json?: boolean;
}

interface LimitOption {
  readonly limit?: string;
}

interface ListOptions extends JsonOption, LimitOption {
  readonly status?: string;
  readonly kind?: string;
}

interface CreateOptions extends JsonOption {
  readonly confidence?: string;
  readonly contextKey?: string;
  readonly contextName?: string;
  readonly contextType?: string;
  readonly entity?: string;
  readonly kind?: string;
}

interface UpdateOptions extends JsonOption {
  readonly confidence?: string;
  readonly entity?: string;
  readonly kind?: string;
  readonly text?: string;
}

interface ForgetOptions extends JsonOption {
  readonly reason?: string;
  readonly yes?: boolean;
}

interface ForgetPromptOptions extends JsonOption, LimitOption {
  readonly provider?: string;
  readonly reason?: string;
  readonly target?: string;
  readonly yes?: boolean;
}

interface DocumentsOptions extends JsonOption, LimitOption {
  readonly provider?: string;
  readonly status?: string;
}

const MEMORY_KINDS = [
  "key_fact",
  "preference",
  "open_loop",
  "role",
  "project",
  "communication_style",
  "recent_context",
] as const;

const CONTEXT_TYPES = [
  "user",
  "org",
  "project",
  "repo",
  "customer",
  "agent",
  "workflow",
] as const;

const PROVIDERS = ["gmail", "slack", "github", "notion"] as const;

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function parseConfidence(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function parseMemoryKind(value: string | undefined): MemoryKind | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    MEMORY_KINDS.some((kind) => {
      return kind === value;
    })
  ) {
    return value as MemoryKind;
  }
  console.error(chalk.red("✗ Unsupported memory kind"));
  console.error(chalk.dim(`  Use one of: ${MEMORY_KINDS.join(", ")}`));
  process.exit(1);
}

function parseProvider(
  value: string | undefined,
): MemorySourceProvider | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    PROVIDERS.some((provider) => {
      return provider === value;
    })
  ) {
    return value as MemorySourceProvider;
  }
  console.error(chalk.red("✗ Unsupported memory provider"));
  console.error(chalk.dim(`  Use one of: ${PROVIDERS.join(", ")}`));
  process.exit(1);
}

function parseContextSpace(options: CreateOptions) {
  if (!options.contextKey && !options.contextType && !options.contextName) {
    return undefined;
  }
  const type = options.contextType ?? "user";
  if (
    !CONTEXT_TYPES.some((contextType) => {
      return contextType === type;
    })
  ) {
    console.error(chalk.red("✗ Unsupported context space type"));
    console.error(chalk.dim(`  Use one of: ${CONTEXT_TYPES.join(", ")}`));
    process.exit(1);
  }
  if (!options.contextKey || !options.contextName) {
    console.error(
      chalk.red("✗ --context-key and --context-name are required together"),
    );
    console.error(
      chalk.dim(
        '  Example: zero memory create "Fact" --context-type repo --context-key github:vm0-ai/vm0 --context-name vm0-ai/vm0',
      ),
    );
    process.exit(1);
  }
  return {
    type: type as (typeof CONTEXT_TYPES)[number],
    key: options.contextKey,
    displayName: options.contextName,
  };
}

function requireYes(options: ForgetOptions | ForgetPromptOptions): void {
  if (options.yes) {
    return;
  }
  console.error(chalk.red("✗ --yes is required for forget operations"));
  console.error(
    chalk.dim("  This records tombstones and removes active search results"),
  );
  process.exit(1);
}

export const listCommand = new Command()
  .name("list")
  .description("List lifecycle-aware structured memories")
  .option("--status <status>", "Filter by active or archived", "active")
  .option("--kind <kind>", "Filter by memory kind")
  .option("--limit <limit>", "Maximum rows to return")
  .option("--json", "Print machine-readable JSON")
  .action(
    withErrorHandler(async (options: ListOptions) => {
      const response = await listZeroMemory({
        status: options.status === "archived" ? "archived" : "active",
        kind: parseMemoryKind(options.kind),
        limit: parseLimit(options.limit),
      });
      if (options.json) {
        console.log(JSON.stringify(response));
        return;
      }
      printMemoryList(response);
    }),
  );

export const createCommand = new Command()
  .name("create")
  .description("Create a direct structured memory")
  .argument("<text>", "Memory text")
  .option("--kind <kind>", "Memory kind", "key_fact")
  .option("--confidence <confidence>", "Confidence 0-100")
  .option("--entity <name>", "Entity display name")
  .option("--context-type <type>", "Context space type")
  .option("--context-key <key>", "Context space key")
  .option("--context-name <name>", "Context space display name")
  .option("--json", "Print machine-readable JSON")
  .action(
    withErrorHandler(async (text: string, options: CreateOptions) => {
      const memory = await createZeroMemory({
        text,
        kind: parseMemoryKind(options.kind) ?? "key_fact",
        confidence: parseConfidence(options.confidence) ?? 90,
        contextSpace: parseContextSpace(options),
        entityDisplayName: options.entity,
      });
      if (options.json) {
        console.log(JSON.stringify({ memory }));
        return;
      }
      printMemoryCreated(memory);
    }),
  );

export const updateCommand = new Command()
  .name("update")
  .description("Update a structured memory and create a new version")
  .argument("<memory-id>", "Memory ID")
  .option("--text <text>", "Replacement memory text")
  .option("--kind <kind>", "Replacement memory kind")
  .option("--confidence <confidence>", "Confidence 0-100")
  .option("--entity <name>", "Entity display name")
  .option("--json", "Print machine-readable JSON")
  .action(
    withErrorHandler(async (memoryId: string, options: UpdateOptions) => {
      const memory = await updateZeroMemory(memoryId, {
        text: options.text,
        kind: parseMemoryKind(options.kind),
        confidence: parseConfidence(options.confidence),
        entityDisplayName: options.entity,
      });
      if (options.json) {
        console.log(JSON.stringify({ memory }));
        return;
      }
      printMemoryUpdated(memory);
    }),
  );

export const forgetCommand = new Command()
  .name("forget")
  .description("Forget one structured memory by ID")
  .argument("<memory-id>", "Memory ID")
  .option("--reason <reason>", "Reason to record in the tombstone")
  .option("--yes", "Confirm the forget operation")
  .option("--json", "Print machine-readable JSON")
  .action(
    withErrorHandler(async (memoryId: string, options: ForgetOptions) => {
      requireYes(options);
      const response = await forgetZeroMemory(memoryId, {
        reason: options.reason,
      });
      if (options.json) {
        console.log(JSON.stringify(response));
        return;
      }
      printMemoryForget(response);
    }),
  );

export const forgetPromptCommand = new Command()
  .name("forget-prompt")
  .description("Forget memories or documents matching a prompt")
  .argument("<prompt>", "Forget prompt")
  .option("--target <target>", "all, memories, or documents", "all")
  .option("--provider <provider>", "Filter documents by provider")
  .option("--limit <limit>", "Maximum matches to forget")
  .option("--reason <reason>", "Reason to record in tombstones")
  .option("--yes", "Confirm the forget operation")
  .option("--json", "Print machine-readable JSON")
  .action(
    withErrorHandler(async (prompt: string, options: ForgetPromptOptions) => {
      requireYes(options);
      const targetKind =
        options.target === "memories" || options.target === "documents"
          ? options.target
          : "all";
      const response = await forgetZeroMemoryByPrompt({
        prompt,
        targetKind,
        provider: parseProvider(options.provider),
        limit: parseLimit(options.limit) ?? 5,
        reason: options.reason,
      });
      if (options.json) {
        console.log(JSON.stringify(response));
        return;
      }
      printMemoryForget(response);
    }),
  );

export const historyCommand = new Command()
  .name("history")
  .description("List memory, document, or profile version history")
  .argument("<target-kind>", "memory, document, or profile")
  .argument("<target-id>", "Target ID")
  .option("--limit <limit>", "Maximum versions to return")
  .option("--json", "Print machine-readable JSON")
  .action(
    withErrorHandler(
      async (
        targetKind: string,
        targetId: string,
        options: JsonOption & LimitOption,
      ) => {
        if (
          targetKind !== "memory" &&
          targetKind !== "document" &&
          targetKind !== "profile"
        ) {
          console.error(chalk.red("✗ Unsupported history target"));
          console.error(chalk.dim("  Use one of: memory, document, profile"));
          process.exit(1);
        }
        const response = await listZeroMemoryHistory({
          targetKind,
          targetId,
          limit: parseLimit(options.limit),
        });
        if (options.json) {
          console.log(JSON.stringify(response));
          return;
        }
        printMemoryHistory(response);
      },
    ),
  );

export const documentsCommand = new Command()
  .name("documents")
  .description("List indexed memory documents")
  .option("--status <status>", "active, archived, or deleted", "active")
  .option("--provider <provider>", "Filter by provider")
  .option("--limit <limit>", "Maximum rows to return")
  .option("--json", "Print machine-readable JSON")
  .action(
    withErrorHandler(async (options: DocumentsOptions) => {
      const status =
        options.status === "archived" || options.status === "deleted"
          ? options.status
          : "active";
      const response = await listZeroMemoryDocuments({
        status,
        provider: parseProvider(options.provider),
        limit: parseLimit(options.limit),
      });
      if (options.json) {
        console.log(JSON.stringify(response));
        return;
      }
      printMemoryDocuments(response);
    }),
  );

export const forgottenCommand = new Command()
  .name("forgotten")
  .description("List forgotten memory tombstones")
  .option("--limit <limit>", "Maximum rows to return")
  .option("--json", "Print machine-readable JSON")
  .action(
    withErrorHandler(async (options: JsonOption & LimitOption) => {
      const response = await listZeroMemoryForgotten({
        limit: parseLimit(options.limit),
      });
      if (options.json) {
        console.log(JSON.stringify(response));
        return;
      }
      printMemoryForgotten(response);
    }),
  );
