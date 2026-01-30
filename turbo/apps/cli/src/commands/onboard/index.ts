import { Command } from "commander";
import chalk from "chalk";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
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
  createProgressiveProgress,
  type ProgressiveProgress,
} from "../../lib/ui/progress-line.js";
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
  progress: ProgressiveProgress;
}

async function handleAuthentication(ctx: OnboardContext): Promise<void> {
  ctx.progress.startStep("Authentication");

  const authenticated = await isAuthenticated();
  if (authenticated) {
    ctx.progress.completeStep();
    return;
  }

  if (!ctx.interactive) {
    ctx.progress.failStep();
    console.error(chalk.red("Error: Not authenticated"));
    console.error("Run 'vm0 auth login' first or set VM0_TOKEN");
    process.exit(1);
  }

  await runAuthFlow({
    onInitiating: () => {
      // No detail needed - step header is enough
    },
    onDeviceCodeReady: (url, code, expiresIn) => {
      ctx.progress.detail(`Visit: ${url}`);
      ctx.progress.detail(`Code: ${code}`);
      ctx.progress.detail(`Expires in ${expiresIn} minutes`);
      ctx.progress.detail("Waiting for confirmation...");
    },
    onPolling: () => {
      // Don't add detail for each poll - would create too many lines
    },
    onSuccess: () => {
      // Will be shown as completed step
    },
    onError: (error) => {
      ctx.progress.failStep();
      console.error(chalk.red(`\n${error.message}`));
      process.exit(1);
    },
  });

  ctx.progress.completeStep();
}

async function handleModelProvider(ctx: OnboardContext): Promise<void> {
  ctx.progress.startStep("Model Provider Setup");

  const providerStatus = await checkModelProviderStatus();
  if (providerStatus.hasProvider) {
    ctx.progress.completeStep();
    return;
  }

  if (!ctx.interactive) {
    ctx.progress.failStep();
    console.error(chalk.red("Error: No model provider configured"));
    console.error("Run 'vm0 model-provider setup' first");
    process.exit(1);
  }

  ctx.progress.detail("Setup required...");

  const choices = getProviderChoices();
  const providerType = await promptSelect<ModelProviderType>(
    "Select provider type:",
    choices.map((c) => ({
      title: c.label,
      value: c.type,
      description: c.helpText,
    })),
  );

  if (!providerType) {
    process.exit(0);
  }

  const selectedChoice = choices.find((c) => c.type === providerType);

  const credential = await promptPassword(
    `Enter your ${selectedChoice?.credentialLabel ?? "credential"}:`,
  );

  if (!credential) {
    console.log(chalk.dim("Cancelled"));
    process.exit(0);
  }

  const result = await setupModelProvider(providerType, credential);
  ctx.progress.detail(
    `${providerType} ${result.created ? "created" : "updated"}${result.isDefault ? ` (default for ${result.framework})` : ""}`,
  );

  ctx.progress.completeStep();
}

async function handleAgentCreation(ctx: OnboardContext): Promise<string> {
  ctx.progress.startStep("Create Agent");

  let agentName = ctx.options.name ?? DEFAULT_AGENT_NAME;

  if (!ctx.options.yes && !ctx.options.name && ctx.interactive) {
    const inputName = await promptText(
      "Enter agent name:",
      DEFAULT_AGENT_NAME,
      (value: string) => {
        if (!validateAgentName(value)) {
          return "Invalid name: 3-64 chars, alphanumeric + hyphens, start/end with letter/number";
        }
        return true;
      },
    );

    if (!inputName) {
      process.exit(0);
    }
    agentName = inputName;
  }

  if (!validateAgentName(agentName)) {
    ctx.progress.failStep();
    console.error(
      chalk.red(
        "Invalid agent name: must be 3-64 chars, alphanumeric + hyphens",
      ),
    );
    process.exit(1);
  }

  if (existsSync(agentName)) {
    ctx.progress.failStep();
    console.error(chalk.red(`${agentName}/ already exists`));
    console.log();
    console.log("Remove it first or choose a different name:");
    console.log(chalk.cyan(`  rm -rf ${agentName}`));
    process.exit(1);
  }

  await mkdir(agentName, { recursive: true });
  ctx.progress.detail(`Created ${agentName}/`);

  ctx.progress.completeStep();
  return agentName;
}

async function handlePluginInstallation(
  ctx: OnboardContext,
  agentName: string,
): Promise<void> {
  ctx.progress.startStep("Claude Plugin Install");

  // Ask if user wants to install the plugin
  let shouldInstall = true;
  if (!ctx.options.yes && ctx.interactive) {
    const confirmed = await promptConfirm(
      "Install VM0 Claude Plugin?",
      true, // default: Yes
    );
    shouldInstall = confirmed ?? true;
  }

  if (!shouldInstall) {
    ctx.progress.detail("Skipped");
    ctx.progress.completeStep();
    return;
  }

  // Always use project scope since we're creating a new project
  const scope: PluginScope = "project";

  try {
    // Get absolute path for the agent directory
    const agentDir = path.resolve(process.cwd(), agentName);

    const result = await installVm0Plugin(scope, agentDir);
    ctx.progress.detail(
      `Installed ${result.pluginId} (scope: ${result.scope})`,
    );
  } catch (error) {
    handlePluginError(error);
  }

  ctx.progress.completeStep();
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

    // Print welcome banner once at the start (it will scroll away)
    if (interactive) {
      console.log();
      renderOnboardWelcome();
      console.log();
    }

    const progress = createProgressiveProgress(interactive);
    const ctx: OnboardContext = { interactive, options, progress };

    await handleAuthentication(ctx);
    await handleModelProvider(ctx);
    const agentName = await handleAgentCreation(ctx);
    await handlePluginInstallation(ctx, agentName);

    // Mark final step as complete (no connector line after)
    progress.startStep("Complete");
    progress.setFinalStep();
    progress.completeStep();

    printNextSteps(agentName);
  });
