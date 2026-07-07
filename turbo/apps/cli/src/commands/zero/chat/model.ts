import chalk from "chalk";
import { Command } from "commander";
import {
  MODEL_FIRST_SELECTION_PROVIDER_ID,
  type ChatThreadMetadata,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { OrgModelPolicy } from "@vm0/api-contracts/contracts/model-providers";

import {
  getZeroChatThread,
  listZeroModelPolicies,
  updateZeroChatThreadModelSelection,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { formatModelProviderRoute } from "../../../lib/domain/model-policy-display";

interface ModelOptions {
  readonly help?: boolean;
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

function printCurrentModel(thread: ChatThreadMetadata): void {
  console.log(chalk.green("✓ Chat thread loaded"));
  console.log(chalk.dim(`  Thread: ${thread.id}`));
  console.log(chalk.dim(`  Title:  ${thread.title ?? "(untitled)"}`));
  console.log(chalk.dim(`  Model:  ${thread.selectedModel ?? "(default)"}`));
}

async function printModelHelp(command: Command): Promise<void> {
  const result = await listZeroModelPolicies();
  console.log(command.helpInformation().trimEnd());
  console.log();
  console.log(chalk.bold("Switchable models:"));
  printSwitchableModels(result.policies);
  console.log();
  console.log("Use the model id in parentheses:");
  console.log(chalk.cyan("  zero chat model <model>"));
}

async function printCurrentModelAndChoices(threadId: string): Promise<void> {
  const [thread, result] = await Promise.all([
    getZeroChatThread({ threadId }),
    listZeroModelPolicies(),
  ]);

  printCurrentModel(thread);
  console.log();
  console.log(chalk.bold("Switchable models:"));
  printSwitchableModels(result.policies);
  console.log();
  console.log("Switch models:");
  console.log(chalk.cyan("  zero chat model <model>"));
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
    modelSelection: {
      modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
      selectedModel: model,
    },
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
  .option("-h, --help", "Show help with switchable models")
  .addHelpText(
    "after",
    `
Examples:
  Show this chat model:  zero chat model
  Switch this model:    zero chat model claude-sonnet-5

Notes:
  - Uses ZERO_CHAT_THREAD_ID from the current web chat thread
  - Authenticates via ZERO_TOKEN (requires chat-thread:write capability to switch)`,
  )
  .action(
    withErrorHandler(
      async (model: string | undefined, options: ModelOptions) => {
        if (options.help) {
          await printModelHelp(modelCommand);
          return;
        }

        const threadId = getCurrentChatThreadId();
        if (!threadId) {
          printUsageError(
            "ZERO_CHAT_THREAD_ID is not set",
            "Run this command from a Zero web chat thread.",
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
