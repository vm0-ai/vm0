import { Command } from "commander";
import chalk from "chalk";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import { validateAgentName } from "../lib/domain/yaml-validator.js";
import {
  isInteractive,
  promptText,
  promptSelect,
  promptPassword,
} from "../lib/utils/prompt-utils.js";
import { renderOnboardWelcome } from "../lib/ui/welcome-box.js";
import {
  createOnboardProgress,
  type StepStatus,
} from "../lib/ui/progress-line.js";
import {
  isAuthenticated,
  runAuthFlow,
  checkModelProviderStatus,
  getProviderChoices,
  setupModelProvider,
  installAllClaudeSkills,
  handleFetchError,
  SKILLS,
  PRIMARY_SKILL_NAME,
} from "../lib/domain/onboard/index.js";
import type { ModelProviderType } from "@vm0/core";

const DEFAULT_AGENT_NAME = "my-vm0-agent";

interface OnboardOptions {
  yes?: boolean;
  name?: string;
}

interface OnboardContext {
  interactive: boolean;
  options: OnboardOptions;
  updateProgress: (index: number, status: StepStatus) => void;
}

async function handleAuthentication(ctx: OnboardContext): Promise<void> {
  ctx.updateProgress(0, "in-progress");

  const authenticated = await isAuthenticated();
  if (authenticated) {
    ctx.updateProgress(0, "completed");
    return;
  }

  if (!ctx.interactive) {
    console.error(chalk.red("Error: Not authenticated"));
    console.error("Run 'vm0 auth login' first or set VM0_TOKEN");
    process.exit(1);
  }

  console.log(chalk.dim("Authentication required..."));
  console.log();

  await runAuthFlow({
    onInitiating: () => {
      console.log("Initiating authentication...");
    },
    onDeviceCodeReady: (url, code, expiresIn) => {
      console.log(chalk.green("\nDevice code generated"));
      console.log(chalk.cyan(`\nTo authenticate, visit: ${url}`));
      console.log(`And enter this code: ${chalk.bold(code)}`);
      console.log(`\nThe code expires in ${expiresIn} minutes.`);
      console.log("\nWaiting for authentication...");
    },
    onPolling: () => {
      process.stdout.write(chalk.dim("."));
    },
    onSuccess: () => {
      console.log(chalk.green("\nAuthentication successful!"));
      console.log("Your credentials have been saved.");
    },
    onError: (error) => {
      console.error(chalk.red(`\n${error.message}`));
      process.exit(1);
    },
  });

  ctx.updateProgress(0, "completed");
}

async function handleModelProvider(ctx: OnboardContext): Promise<void> {
  ctx.updateProgress(1, "in-progress");

  const providerStatus = await checkModelProviderStatus();
  if (providerStatus.hasProvider) {
    ctx.updateProgress(1, "completed");
    return;
  }

  if (!ctx.interactive) {
    console.error(chalk.red("Error: No model provider configured"));
    console.error("Run 'vm0 model-provider setup' first");
    process.exit(1);
  }

  console.log(chalk.dim("Model provider setup required..."));
  console.log();

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
  if (selectedChoice) {
    console.log();
    console.log(chalk.dim(selectedChoice.helpText));
    console.log();
  }

  const credential = await promptPassword(
    `Enter your ${selectedChoice?.credentialLabel ?? "credential"}:`,
  );

  if (!credential) {
    console.log(chalk.dim("Cancelled"));
    process.exit(0);
  }

  const result = await setupModelProvider(providerType, credential);
  console.log(
    chalk.green(
      `\n✓ Model provider "${providerType}" ${result.created ? "created" : "updated"}${result.isDefault ? ` (default for ${result.framework})` : ""}`,
    ),
  );

  ctx.updateProgress(1, "completed");
}

async function handleAgentCreation(ctx: OnboardContext): Promise<string> {
  ctx.updateProgress(2, "in-progress");

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
    console.error(
      chalk.red(
        "Invalid agent name: must be 3-64 chars, alphanumeric + hyphens",
      ),
    );
    process.exit(1);
  }

  if (existsSync(agentName)) {
    console.error(chalk.red(`\n✗ ${agentName}/ already exists`));
    console.log();
    console.log("Remove it first or choose a different name:");
    console.log(chalk.cyan(`  rm -rf ${agentName}`));
    process.exit(1);
  }

  await mkdir(agentName, { recursive: true });
  console.log(chalk.green(`✓ Created ${agentName}/`));

  ctx.updateProgress(2, "completed");
  return agentName;
}

async function handleSkillInstallation(
  ctx: OnboardContext,
  agentName: string,
): Promise<void> {
  ctx.updateProgress(3, "in-progress");

  try {
    const result = await installAllClaudeSkills(agentName);
    result.skills.forEach((skillResult, i) => {
      const skillName = SKILLS[i]?.name ?? "unknown";
      console.log(
        chalk.green(
          `✓ Installed ${skillName} skill to ${skillResult.skillDir}`,
        ),
      );
    });
  } catch (error) {
    handleFetchError(error);
  }

  ctx.updateProgress(3, "completed");
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

    if (interactive) {
      console.log();
      renderOnboardWelcome();
      console.log();
    }

    const progress = createOnboardProgress();

    const updateProgress = (index: number, status: StepStatus) => {
      progress.update(index, status);
      if (interactive) {
        console.clear();
        renderOnboardWelcome();
        console.log();
        progress.render();
        console.log();
      }
    };

    if (interactive) {
      progress.render();
      console.log();
    }

    const ctx: OnboardContext = { interactive, options, updateProgress };

    await handleAuthentication(ctx);
    await handleModelProvider(ctx);
    const agentName = await handleAgentCreation(ctx);
    await handleSkillInstallation(ctx, agentName);

    printNextSteps(agentName);
  });
