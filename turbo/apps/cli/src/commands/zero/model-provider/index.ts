import { Command } from "commander";
import chalk from "chalk";
import { listZeroModelPolicies } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import {
  formatModelPolicyStatus,
  getModelProviderRouteKind,
  getModelProviderTypeLabel,
} from "../../../lib/domain/model-policy-display";

export const MODEL_PROVIDER_SET_GUIDANCE = [
  "Model provider routing is configured in the web app.",
  "",
  "Organization admins: open https://app.vm0.ai, use the top-left organization menu, choose Manage, then add, delete, or adjust model providers.",
  "",
  "If an organization admin sets a model provider to subscription, members must use the bottom-left user menu, choose Preferences / Personal Models, and connect their personal subscription.",
].join("\n");

const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description(
    "List provider routing for each model allowed by the organization",
  )
  .action(
    withErrorHandler(async () => {
      const result = await listZeroModelPolicies();

      if (result.policies.length === 0) {
        console.log(
          chalk.dim(
            "No model provider routes are allowed for this organization",
          ),
        );
        return;
      }

      console.log(chalk.bold("Model Provider Routes:"));
      console.log();

      for (const policy of result.policies) {
        const defaultMarker = policy.isDefault ? chalk.dim(" (default)") : "";
        console.log(
          `  - ${policy.modelLabel} ${chalk.dim(`(${policy.model})`)}${defaultMarker}`,
        );
        console.log(`    provider: ${getModelProviderRouteKind(policy)}`);
        console.log(
          `    provider type: ${policy.defaultProviderType} (${getModelProviderTypeLabel(policy.defaultProviderType)})`,
        );

        const status = formatModelPolicyStatus(policy);
        if (status) {
          console.log(chalk.yellow(`    status: ${status}`));
        }
      }
    }),
  );

export const setCommand = new Command()
  .name("set")
  .description("Show where to adjust model provider routing")
  .addHelpText("after", `\n${MODEL_PROVIDER_SET_GUIDANCE}`)
  .action(() => {
    console.log(MODEL_PROVIDER_SET_GUIDANCE);
  });

export const zeroModelProviderCommand = new Command()
  .name("model-provider")
  .description("Inspect model provider routing")
  .addCommand(listCommand)
  .addCommand(setCommand);
