import { Command } from "commander";
import chalk from "chalk";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import { validateAgentName } from "../../lib/domain/yaml-validator.js";
import {
  isInteractive,
  promptText,
  promptSelect,
  promptPassword,
  promptConfirm,
} from "../../lib/utils/prompt-utils.js";
import { renderOnboardWelcome } from "../../lib/ui/welcome-box.js";
import {
  createStepRunner,
  type StepContext,
  type StepRunner,
} from "../../lib/ui/step-runner.js";
import {
  isAuthenticated,
  runAuthFlow,
  checkModelProviderStatus,
  getProviderChoices,
  setupModelProvider,
  installVm0Plugin,
  handlePluginError,
  PRIMARY_SKILL_NAME,
  type PluginScope,
} from "../../lib/domain/onboard/index.js";
import type { ModelProviderType } from "@vm0/core";

const DEFAULT_AGENT_NAME = "my-vm0-agent";

interface OnboardOptions {
  yes?: boolean;
  name?: string;
}

interface OnboardContext {
  interactive: boolean;
  options: OnboardOptions;
  runner: StepRunner;
}

async function handleAuthentication(ctx: OnboardContext): Promise<void> {
  await ctx.runner.step("Authenticate to vm0.ai", async (step: StepContext) => {
    const authenticated = await isAuthenticated();
    if (authenticated) {
      return;
    }

    if (!ctx.interactive) {
      console.error(chalk.red("Error: Not authenticated"));
      console.error("Run 'vm0 auth login' first or set VM0_TOKEN");
      process.exit(1);
    }

    await runAuthFlow({
      onInitiating: () => {
        // Step header is sufficient
      },
      onDeviceCodeReady: (url, code, expiresIn) => {
        step.detail(`Copy code: ${chalk.cyan.bold(code)}`);
        step.detail(`Open: ${chalk.cyan(url)}`);
        step.detail(chalk.dim(`Expires in ${expiresIn} minutes`));
      },
      onPolling: () => {
        // Don't add detail for each poll
      },
      onSuccess: () => {
        // Will be shown as completed step
      },
      onError: (error) => {
        console.error(chalk.red(`\n${error.message}`));
        process.exit(1);
      },
    });
  });
}

async function handleModelProvider(ctx: OnboardContext): Promise<void> {
  await ctx.runner.step("Set Up Model Provider", async (step: StepContext) => {
    const providerStatus = await checkModelProviderStatus();
    if (providerStatus.hasProvider) {
      return;
    }

    if (!ctx.interactive) {
      console.error(chalk.red("Error: No model provider configured"));
      console.error("Run 'vm0 model-provider setup' first");
      process.exit(1);
    }

    const choices = getProviderChoices();

    step.connector();
    const providerType = await step.prompt(() =>
      promptSelect<ModelProviderType>(
        "Select provider type:",
        choices.map((c) => ({
          title: c.label,
          value: c.type,
        })),
      ),
    );

    if (!providerType) {
      process.exit(0);
    }

    const selectedChoice = choices.find((c) => c.type === providerType);

    // Show provider-specific help text
    if (selectedChoice?.helpText) {
      for (const line of selectedChoice.helpText.split("\n")) {
        step.detail(chalk.dim(line));
      }
    }

    const credential = await step.prompt(() =>
      promptPassword(
        `Enter your ${selectedChoice?.credentialLabel ?? "credential"}:`,
      ),
    );

    if (!credential) {
      console.log(chalk.dim("Cancelled"));
      process.exit(0);
    }

    const result = await setupModelProvider(providerType, credential);
    step.detail(
      chalk.green(
        `${providerType} ${result.created ? "created" : "updated"}${result.isDefault ? ` (default for ${result.framework})` : ""}`,
      ),
    );
  });
}

async function handleAgentCreation(ctx: OnboardContext): Promise<string> {
  let agentName = ctx.options.name ?? DEFAULT_AGENT_NAME;

  await ctx.runner.step("Create New Project", async (step: StepContext) => {
    // Interactive mode: prompt for name, re-prompt if folder exists
    if (!ctx.options.yes && !ctx.options.name && ctx.interactive) {
      let folderExists = true;

      while (folderExists) {
        step.connector();
        const inputName = await step.prompt(() =>
          promptText(
            "Enter project name:",
            DEFAULT_AGENT_NAME,
            (value: string) => {
              if (!validateAgentName(value)) {
                return "Invalid name: 3-64 chars, alphanumeric + hyphens, start/end with letter/number";
              }
              return true;
            },
          ),
        );

        if (!inputName) {
          process.exit(0);
        }
        agentName = inputName;

        if (existsSync(agentName)) {
          step.detail(
            chalk.yellow(`${agentName}/ already exists, choose another name`),
          );
        } else {
          folderExists = false;
        }
      }
    } else {
      // Non-interactive mode: validate and fail if exists
      if (!validateAgentName(agentName)) {
        console.error(
          chalk.red(
            "Invalid agent name: must be 3-64 chars, alphanumeric + hyphens",
          ),
        );
        process.exit(1);
      }

      if (existsSync(agentName)) {
        console.error(chalk.red(`${agentName}/ already exists`));
        console.log();
        console.log("Remove it first or choose a different name:");
        console.log(chalk.cyan(`  rm -rf ${agentName}`));
        process.exit(1);
      }
    }

    await mkdir(agentName, { recursive: true });
    step.detail(chalk.green(`Created ${agentName}/`));
  });

  return agentName;
}

async function handlePluginInstallation(
  ctx: OnboardContext,
  agentName: string,
): Promise<void> {
  await ctx.runner.step("Install Claude Plugin", async (step: StepContext) => {
    // Ask if user wants to install the plugin
    let shouldInstall = true;
    if (!ctx.options.yes && ctx.interactive) {
      step.connector();
      const confirmed = await step.prompt(() =>
        promptConfirm("Install VM0 Claude Plugin?", true),
      );
      shouldInstall = confirmed ?? true;
    }

    if (!shouldInstall) {
      step.detail(chalk.dim("Skipped"));
      return;
    }

    // Install at project scope in the demo project directory
    const scope: PluginScope = "project";

    try {
      const agentDir = `${process.cwd()}/${agentName}`;
      const result = await installVm0Plugin(scope, agentDir);
      step.detail(
        chalk.green(`Installed ${result.pluginId} (scope: ${result.scope})`),
      );
    } catch (error) {
      handlePluginError(error);
    }
  });
}

function printNextSteps(agentName: string): void {
  console.log();
  console.log(chalk.bold("Next step:"));
  console.log();
  console.log(
    `  ${chalk.cyan(`cd ${agentName} && claude "/${PRIMARY_SKILL_NAME} let's build a workflow"`)}`,
  );
  console.log();
}

export const onboardCommand = new Command()
  .name("onboard")
  .description("Guided setup for new VM0 users")
  .option("-y, --yes", "Skip confirmation prompts")
  .option("--name <name>", `Agent name (default: ${DEFAULT_AGENT_NAME})`)
  .action(async (options: OnboardOptions) => {
    const interactive = isInteractive();

    // Clear screen and print welcome banner at the start
    if (interactive) {
      process.stdout.write("\x1b[2J\x1b[H");
      console.log();
      renderOnboardWelcome();
      console.log();
    }

    const runner = createStepRunner({
      interactive,
      header: interactive ? renderOnboardWelcome : undefined,
    });
    const ctx: OnboardContext = { interactive, options, runner };

    await handleAuthentication(ctx);
    await handleModelProvider(ctx);
    const agentName = await handleAgentCreation(ctx);
    await handlePluginInstallation(ctx, agentName);

    // Final step
    await ctx.runner.finalStep("Completed", async () => {
      // Empty - just marks completion
    });

    printNextSteps(agentName);
  });
