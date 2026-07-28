import chalk from "chalk";
import { Command } from "commander";
import type { ChatThreadMetadata } from "@vm0/api-contracts/contracts/chat-threads";
import type {
  OrgModelPoliciesResponse,
  OrgModelPolicy,
} from "@vm0/api-contracts/contracts/model-providers";
import { getModelDisplayName } from "@vm0/core/model-display-name";

import {
  getZeroChatThread,
  listZeroModelPolicies,
  updateZeroChatThreadModelSelection,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { formatModelProviderRoute } from "../../../lib/domain/model-policy-display";
import { isUuid } from "../../../lib/utils/uuid";

interface ModelOptions {
  readonly help?: boolean;
  readonly thread?: string;
}

function getCurrentChatThreadId(): string | undefined {
  return process.env.ZERO_CHAT_THREAD_ID?.trim() || undefined;
}

function printUsageError(message: string, hint: string): never {
  console.error(chalk.red(`✗ ${message}`));
  console.error(chalk.dim(`  ${hint}`));
  process.exit(1);
}

function switchablePolicies(policies: readonly OrgModelPolicy[]) {
  return policies.filter((policy) => {
    return policy.routeStatus === "valid";
  });
}

function formatModelName(policy: OrgModelPolicy): string {
  return `${policy.modelLabel} ${chalk.dim(`(${policy.model})`)}`;
}

function printSwitchableModels(policies: readonly OrgModelPolicy[]): void {
  const switchable = switchablePolicies(policies);
  if (switchable.length === 0) {
    console.log(chalk.dim("No switchable models are available for this user"));
    return;
  }

  for (const policy of switchable) {
    const defaultMarker = policy.isDefault ? chalk.dim(" (default)") : "";
    console.log(`  - ${formatModelName(policy)}${defaultMarker}`);
    console.log(`    provider: ${formatModelProviderRoute(policy)}`);
  }
}

function formatThreadModel(
  thread: ChatThreadMetadata,
  policies: OrgModelPoliciesResponse,
): string {
  const model = thread.selectedModel ?? policies.workspaceDefaultModel;
  if (!model) {
    return "(default)";
  }
  const policy = policies.policies.find((candidate) => {
    return candidate.model === model;
  });
  return `${policy?.modelLabel ?? getModelDisplayName(model)} (${model})`;
}

function printCurrentModel(
  thread: ChatThreadMetadata,
  policies: OrgModelPoliciesResponse,
): void {
  console.log(chalk.green("✓ Chat thread loaded"));
  console.log(chalk.dim(`  Thread: ${thread.id}`));
  console.log(chalk.dim(`  Title:  ${thread.title ?? "(untitled)"}`));
  console.log(chalk.dim(`  Model:  ${formatThreadModel(thread, policies)}`));
}

async function printModelHelp(command: Command): Promise<void> {
  const result = await listZeroModelPolicies();
  console.log(command.helpInformation().trimEnd());
  console.log();
  console.log(chalk.bold("Switchable models:"));
  printSwitchableModels(result.policies);
  console.log();
  console.log("Use the model id in parentheses:");
  console.log(chalk.cyan("  zero chat model [--thread <thread-id>] <model>"));
}

async function printCurrentModelAndChoices(threadId: string): Promise<void> {
  const [thread, result] = await Promise.all([
    getZeroChatThread({ threadId }),
    listZeroModelPolicies(),
  ]);

  printCurrentModel(thread, result);
  console.log();
  console.log(chalk.bold("Switchable models:"));
  printSwitchableModels(result.policies);
  console.log();
  console.log("Switch models:");
  console.log(chalk.cyan(`  zero chat model --thread ${threadId} <model>`));
}

async function switchModel(threadId: string, model: string): Promise<void> {
  const result = await listZeroModelPolicies();
  const policy = result.policies.find((candidate) => {
    return candidate.model === model;
  });

  if (!policy) {
    printUsageError(`Unknown model: ${model}`, "Run: zero chat model --help");
  }

  if (policy.routeStatus !== "valid") {
    const reason = policy.routeStatusReason
      ? ` (${policy.routeStatusReason})`
      : "";
    printUsageError(
      `Model is not switchable: ${model}${reason}`,
      "Run: zero chat model --help",
    );
  }

  const updated = await updateZeroChatThreadModelSelection({
    threadId,
    model,
  });

  console.log(chalk.green("✓ Chat model updated"));
  console.log(chalk.dim(`  Thread: ${updated.threadId}`));
  console.log(chalk.dim(`  Model:  ${policy.modelLabel} (${model})`));
}

export const modelCommand = new Command()
  .name("model")
  .description("Show or switch the current web chat thread model")
  .argument("[model]", "Model id to use for this chat thread")
  .helpOption(false)
  .option("--thread <id>", "Chat thread ID (defaults to ZERO_CHAT_THREAD_ID)")
  .option("-h, --help", "Show help with switchable models")
  .addHelpText(
    "after",
    `
Examples:
  Show this chat model:     zero chat model
  Show another chat model:  zero chat model --thread <thread-id>
  Switch this model:        zero chat model claude-sonnet-5
  Switch another model:     zero chat model --thread <thread-id> claude-sonnet-5

Notes:
  - Defaults --thread to ZERO_CHAT_THREAD_ID
  - Authenticates via ZERO_TOKEN (requires chat-thread:write capability to switch)`,
  )
  .action(
    withErrorHandler(
      async (model: string | undefined, options: ModelOptions) => {
        if (options.help) {
          await printModelHelp(modelCommand);
          return;
        }

        const threadId = options.thread?.trim() || getCurrentChatThreadId();
        if (!threadId) {
          printUsageError(
            "ZERO_CHAT_THREAD_ID is not set",
            "Pass --thread <thread-id> or run inside a Zero web chat thread.",
          );
        }
        if (!isUuid(threadId)) {
          printUsageError(
            `Invalid thread ID "${threadId}" — expected a UUID`,
            "Pass a valid UUID with --thread <thread-id>.",
          );
        }

        if (!model) {
          await printCurrentModelAndChoices(threadId);
          return;
        }

        await switchModel(threadId, model);
      },
    ),
  );
