import { Command } from "commander";
import chalk from "chalk";
import { getVm0ModelMultiplier } from "@vm0/api-contracts/contracts/model-providers";
import { listZeroModelPolicies } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import {
  formatModelPolicyStatus,
  formatModelProviderRoute,
  getModelProviderRouteKind,
} from "../../../lib/domain/model-policy-display";

function formatCreditMultiplier(multiplier: number | undefined): string {
  return multiplier === undefined ? "unknown" : `x${multiplier}`;
}

function getCurrentIntegration(): string | null {
  const prompt = process.env.VM0_APPEND_SYSTEM_PROMPT;
  if (!prompt) {
    return null;
  }

  const match = prompt.match(/You are currently running inside:\s*([^\n]+)/i);
  return match?.[1]?.trim().toLowerCase() ?? null;
}

export function getModelSwitchGuidance(integration = getCurrentIntegration()) {
  const normalizedIntegration = integration?.toLowerCase();

  if (normalizedIntegration === "web") {
    return "Switch models from the model selector next to the input box in the web chat.";
  }

  if (normalizedIntegration === "telegram") {
    return "Use /model in Telegram to switch models.";
  }

  return "Open https://app.vm0.ai and switch models from the model selector next to the input box.";
}

const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List models allowed by the current organization")
  .action(
    withErrorHandler(async () => {
      const result = await listZeroModelPolicies();

      if (result.policies.length === 0) {
        console.log(chalk.dim("No models are allowed for this organization"));
        return;
      }

      console.log(chalk.bold("Allowed Models:"));
      console.log();

      for (const policy of result.policies) {
        const defaultMarker = policy.isDefault ? chalk.dim(" (default)") : "";
        console.log(
          `  - ${policy.modelLabel} ${chalk.dim(`(${policy.model})`)}${defaultMarker}`,
        );
        console.log(`    provider: ${formatModelProviderRoute(policy)}`);

        if (getModelProviderRouteKind(policy) === "built-in") {
          console.log(
            `    price coefficient: ${formatCreditMultiplier(getVm0ModelMultiplier(policy.model))}`,
          );
        }

        const status = formatModelPolicyStatus(policy);
        if (status) {
          console.log(chalk.yellow(`    status: ${status}`));
        }
      }

      console.log();
      console.log(
        chalk.dim(
          "Use `zero model-provider set --help` to see how to switch each model between built-in and BYOK.",
        ),
      );
    }),
  );

export const switchCommand = new Command()
  .name("switch")
  .description("Show how to switch models in the current environment")
  .action(() => {
    console.log(getModelSwitchGuidance());
  });

export const zeroModelCommand = new Command()
  .name("model")
  .description("List available models and model-switching guidance")
  .addCommand(listCommand)
  .addCommand(switchCommand);
