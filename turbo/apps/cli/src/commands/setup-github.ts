import { Command } from "commander";
import chalk from "chalk";
import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { execSync, spawnSync } from "child_process";
import path from "path";
import { parse as parseYaml } from "yaml";
import { extractVariableReferences, groupVariablesBySource } from "@vm0/core";
import { getToken } from "../lib/api/config";
import { promptConfirm } from "../lib/utils/prompt-utils";

// ============================================================================
// Prerequisite Checks
// ============================================================================

function isGhInstalled(): boolean {
  try {
    execSync("gh --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isGhAuthenticated(): boolean {
  try {
    execSync("gh auth status", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getGitRoot(): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function getRelativeWorkingDir(gitRoot: string): string | null {
  const cwd = process.cwd();
  if (cwd === gitRoot) {
    return null;
  }
  const relativePath = path.relative(gitRoot, cwd);
  // Ensure forward slashes for YAML (Windows compatibility)
  return relativePath.replace(/\\/g, "/");
}

async function checkPrerequisites(): Promise<
  { token: string; gitRoot: string } | undefined
> {
  console.log("Checking prerequisites...");

  // 1. Check if in git repository
  const gitRoot = getGitRoot();
  if (!gitRoot) {
    console.log(chalk.red("✗ Not in a git repository"));
    console.log();
    console.log("This command must be run from within a git repository.");
    console.log();
    console.log("To initialize a git repository, run:");
    console.log(`  ${chalk.cyan("git init")}`);
    process.exit(1);
  }
  console.log(chalk.green("✓ Git repository detected"));

  // 2. Check gh CLI installed
  if (!isGhInstalled()) {
    console.log(chalk.red("✗ GitHub CLI (gh) is not installed"));
    console.log();
    console.log("GitHub CLI is required for this command.");
    console.log();
    console.log(`  macOS:  ${chalk.cyan("brew install gh")}`);
    console.log(`  Other:  ${chalk.cyan("https://cli.github.com/")}`);
    console.log();
    console.log("After installation, run:");
    console.log(`  ${chalk.cyan("gh auth login")}`);
    console.log();
    console.log("Then try again:");
    console.log(`  ${chalk.cyan("vm0 setup-github")}`);
    process.exit(1);
  }
  console.log(chalk.green("✓ GitHub CLI (gh) is installed"));

  // 3. Check gh authenticated
  if (!isGhAuthenticated()) {
    console.log(chalk.red("✗ GitHub CLI is not authenticated"));
    console.log();
    console.log("Please authenticate GitHub CLI first:");
    console.log(`  ${chalk.cyan("gh auth login")}`);
    console.log();
    console.log("Then try again:");
    console.log(`  ${chalk.cyan("vm0 setup-github")}`);
    process.exit(1);
  }
  console.log(chalk.green("✓ GitHub CLI is authenticated"));

  // 4. Check VM0 authenticated
  const token = await getToken();
  if (!token) {
    console.log(chalk.red("✗ VM0 not authenticated"));
    console.log();
    console.log("Please authenticate with VM0 first:");
    console.log(`  ${chalk.cyan("vm0 auth login")}`);
    console.log();
    console.log("Then try again:");
    console.log(`  ${chalk.cyan("vm0 setup-github")}`);
    process.exit(1);
  }
  console.log(chalk.green("✓ VM0 authenticated"));

  // 5. Check vm0.yaml exists
  if (!existsSync("vm0.yaml")) {
    console.log(chalk.red("✗ vm0.yaml not found"));
    console.log();
    console.log("This command requires a vm0.yaml configuration file.");
    console.log();
    console.log("To create one, run:");
    console.log(`  ${chalk.cyan("vm0 init")}`);
    console.log();
    console.log("Then try again:");
    console.log(`  ${chalk.cyan("vm0 setup-github")}`);
    process.exit(1);
  }
  console.log(chalk.green("✓ vm0.yaml found"));

  return { token, gitRoot };
}

// ============================================================================
// Workflow File Generation
// ============================================================================

function generatePublishYaml(workingDir: string | null): string {
  const pathPrefix = workingDir ? `${workingDir}/` : "";
  const workingDirYaml = workingDir
    ? `          working-directory: ${workingDir}\n`
    : "";

  return `name: Publish Agent

on:
  push:
    branches: [main]
    paths:
      - '${pathPrefix}vm0.yaml'
      - '${pathPrefix}AGENTS.md'

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Publish Agent
        uses: vm0-ai/compose-action@v1
        id: compose
        with:
          vm0-token: \${{ secrets.VM0_TOKEN }}
${workingDirYaml}
      - name: Show Results
        run: |
          echo "Agent: \${{ steps.compose.outputs.name }}"
          echo "Compose ID: \${{ steps.compose.outputs.compose-id }}"
          echo "Version: \${{ steps.compose.outputs.version-id }}"
          echo "Action: \${{ steps.compose.outputs.action }}"
`;
}

function generateRunYaml(
  agentName: string,
  secrets: string[],
  vars: string[],
): string {
  // Build secrets section (excluding VM0_TOKEN which is passed separately)
  const otherSecrets = secrets.filter((s) => s !== "VM0_TOKEN");
  const secretsLines = otherSecrets
    .map((s) => `            ${s}=\${{ secrets.${s} }}`)
    .join("\n");

  // Build vars section
  const varsLines = vars
    .map((v) => `            ${v}=\${{ vars.${v} }}`)
    .join("\n");

  let yaml = `name: Run Agent

on:
  # Uncomment to enable scheduled runs:
  # schedule:
  #   - cron: '0 1 * * *'  # Daily at 9:00 AM UTC+8
  workflow_dispatch:
    inputs:
      prompt:
        description: 'Prompt for the agent'
        required: false
        default: 'do the job'

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - name: Run Agent
        uses: vm0-ai/run-action@v1
        with:
          agent: ${agentName}
          prompt: \${{ github.event.inputs.prompt || 'do the job' }}
          silent: true
          vm0-token: \${{ secrets.VM0_TOKEN }}`;

  if (secretsLines) {
    yaml += `
          secrets: |
${secretsLines}`;
  }

  if (varsLines) {
    yaml += `
          vars: |
${varsLines}`;
  }

  yaml += "\n";
  return yaml;
}

// ============================================================================
// Variable Extraction
// ============================================================================

interface ExtractedVars {
  secrets: string[];
  vars: string[];
}

function extractSecretsAndVars(config: unknown): ExtractedVars {
  const secrets = new Set<string>();
  const vars = new Set<string>();

  // Extract from ${{ secrets.X }} and ${{ vars.X }} syntax
  const refs = extractVariableReferences(config);
  const grouped = groupVariablesBySource(refs);

  for (const ref of grouped.secrets) {
    secrets.add(ref.name);
  }
  for (const ref of grouped.vars) {
    vars.add(ref.name);
  }

  // Extract from experimental_* shorthand
  const cfg = config as Record<string, unknown>;
  const agents = cfg.agents as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (agents) {
    const agentConfig = Object.values(agents)[0];
    if (agentConfig) {
      const expSecrets = agentConfig.experimental_secrets as
        | string[]
        | undefined;
      const expVars = agentConfig.experimental_vars as string[] | undefined;

      if (expSecrets) {
        for (const s of expSecrets) {
          secrets.add(s);
        }
      }
      if (expVars) {
        for (const v of expVars) {
          vars.add(v);
        }
      }
    }
  }

  // Always include VM0_TOKEN in secrets
  secrets.add("VM0_TOKEN");

  return {
    secrets: Array.from(secrets).sort(),
    vars: Array.from(vars).sort(),
  };
}

// ============================================================================
// User Prompts
// ============================================================================

async function promptYesNo(
  question: string,
  defaultYes: boolean,
): Promise<boolean> {
  const result = await promptConfirm(question, defaultYes);
  // If user cancelled, treat as no
  return result ?? false;
}

// ============================================================================
// GitHub Secrets/Variables Setup
// ============================================================================

function setGitHubSecret(name: string, value: string): boolean {
  const result = spawnSync("gh", ["secret", "set", name], {
    input: value,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return result.status === 0;
}

function setGitHubVariable(name: string, value: string): boolean {
  const result = spawnSync("gh", ["variable", "set", name, "--body", value], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  return result.status === 0;
}

interface SecretStatus {
  name: string;
  found: boolean;
  source?: string;
  value?: string;
}

async function detectSecretValues(
  secrets: string[],
  vars: string[],
  vm0Token: string,
): Promise<{
  secretStatuses: SecretStatus[];
  varStatuses: SecretStatus[];
}> {
  const secretStatuses: SecretStatus[] = secrets.map((name) => {
    if (name === "VM0_TOKEN") {
      return { name, found: true, source: "vm0 auth", value: vm0Token };
    }
    const envValue = process.env[name];
    if (envValue) {
      return { name, found: true, source: "environment", value: envValue };
    }
    return { name, found: false };
  });

  const varStatuses: SecretStatus[] = vars.map((name) => {
    const envValue = process.env[name];
    if (envValue) {
      return { name, found: true, source: "environment", value: envValue };
    }
    return { name, found: false };
  });

  return { secretStatuses, varStatuses };
}

function displaySecretsTable(
  secretStatuses: SecretStatus[],
  varStatuses: SecretStatus[],
): void {
  console.log("┌─────────────────────────────────────────────────────────┐");
  console.log("│ Detected secrets and variables:                         │");
  console.log("├─────────────────────────────────────────────────────────┤");

  if (secretStatuses.length > 0) {
    console.log("│ Secrets:                                                │");
    for (const s of secretStatuses) {
      const status = s.found ? chalk.green("✓") : chalk.red("✗");
      const source = s.found ? `(from ${s.source})` : "not found";
      const paddedName = (s.name + " ").padEnd(23, ".");
      console.log(`│   ${status} ${paddedName} ${source.padEnd(19)}│`);
    }
  }

  if (varStatuses.length > 0) {
    console.log("│ Variables:                                              │");
    for (const v of varStatuses) {
      const status = v.found ? chalk.green("✓") : chalk.red("✗");
      const source = v.found ? `(from ${v.source})` : "not found";
      const paddedName = (v.name + " ").padEnd(23, ".");
      console.log(`│   ${status} ${paddedName} ${source.padEnd(19)}│`);
    }
  }

  console.log("└─────────────────────────────────────────────────────────┘");
}

function showManualSetupInstructions(secrets: string[], vars: string[]): void {
  console.log("Skipped automatic setup. Configure secrets manually:");
  console.log();
  console.log("  Step 1: Get your VM0 token");
  console.log(`    ${chalk.cyan("vm0 auth setup-token")}`);
  console.log();
  console.log("  Step 2: Set GitHub secrets");
  for (const s of secrets) {
    console.log(`    ${chalk.cyan(`gh secret set ${s}`)}`);
  }
  if (vars.length > 0) {
    console.log();
    console.log("  Step 3: Set GitHub variables");
    for (const v of vars) {
      console.log(`    ${chalk.cyan(`gh variable set ${v}`)}`);
    }
  }
}

function showSuccessMessage(): void {
  console.log("┌─────────────────────────────────────────────────────────┐");
  console.log("│ ✓ GitHub Actions setup complete!                        │");
  console.log("├─────────────────────────────────────────────────────────┤");
  console.log("│ Workflows created:                                      │");
  console.log("│   • .github/workflows/publish.yml                       │");
  console.log("│   • .github/workflows/run.yml                           │");
  console.log("│                                                         │");
  console.log("│ Next steps:                                             │");
  console.log("│   1. Commit and push the workflow files                 │");
  console.log("│   2. Push to main branch to trigger publish             │");
  console.log("└─────────────────────────────────────────────────────────┘");
}

function showPartialSuccessMessage(
  missingSecrets: string[],
  missingVars: string[],
): void {
  console.log("┌─────────────────────────────────────────────────────────┐");
  console.log("│ ⚠ Setup partially complete                              │");
  console.log("├─────────────────────────────────────────────────────────┤");
  console.log("│ Missing secrets - set them manually:                    │");
  for (const s of missingSecrets) {
    console.log(`│   gh secret set ${s.padEnd(40)}│`);
  }
  for (const v of missingVars) {
    console.log(`│   gh variable set ${v.padEnd(38)}│`);
  }
  console.log("└─────────────────────────────────────────────────────────┘");
}

function showWorkflowsCreatedMessage(): void {
  console.log("┌─────────────────────────────────────────────────────────┐");
  console.log("│ ✓ Workflow files created!                               │");
  console.log("├─────────────────────────────────────────────────────────┤");
  console.log("│   • .github/workflows/publish.yml                       │");
  console.log("│   • .github/workflows/run.yml                           │");
  console.log("│                                                         │");
  console.log("│ Next steps:                                             │");
  console.log("│   1. Set GitHub secrets (see commands above)            │");
  console.log("│   2. Commit and push the workflow files                 │");
  console.log("│   3. Push to main branch to trigger publish             │");
  console.log("└─────────────────────────────────────────────────────────┘");
}

// ============================================================================
// Main Command
// ============================================================================

export const setupGithubCommand = new Command()
  .name("setup-github")
  .description("Initialize GitHub Actions workflows for agent deployment")
  .option("-f, --force", "Overwrite existing workflow files")
  .option("-y, --yes", "Auto-confirm all prompts")
  .option("--skip-secrets", "Skip automatic secrets/variables setup")
  .action(
    // eslint-disable-next-line complexity -- TODO: refactor complex function
    async (options: {
      force?: boolean;
      yes?: boolean;
      skipSecrets?: boolean;
    }) => {
      // 1. Check prerequisites
      const prereqs = await checkPrerequisites();
      if (!prereqs) {
        process.exit(1);
      }
      const { token: vm0Token, gitRoot } = prereqs;
      const workingDir = getRelativeWorkingDir(gitRoot);
      console.log();

      // 2. Parse vm0.yaml
      console.log("Analyzing vm0.yaml...");
      const content = await readFile("vm0.yaml", "utf8");
      const config = parseYaml(content);
      const agents = (config as Record<string, unknown>).agents as Record<
        string,
        unknown
      >;
      const agentName = Object.keys(agents)[0]!;
      console.log(chalk.green(`✓ Agent: ${agentName}`));

      // 3. Extract secrets and vars
      const { secrets, vars } = extractSecretsAndVars(config);
      console.log(
        chalk.green(
          `✓ Found ${secrets.length} secrets, ${vars.length} variables`,
        ),
      );
      console.log();

      // 4. Check existing workflow files (at git root)
      const publishPath = path.join(gitRoot, ".github/workflows/publish.yml");
      const runPath = path.join(gitRoot, ".github/workflows/run.yml");
      const displayPublishPath = ".github/workflows/publish.yml";
      const displayRunPath = ".github/workflows/run.yml";
      const existingFiles: string[] = [];
      if (existsSync(publishPath)) existingFiles.push(displayPublishPath);
      if (existsSync(runPath)) existingFiles.push(displayRunPath);

      if (existingFiles.length > 0 && !options.force) {
        console.log(chalk.yellow("⚠ Existing workflow files detected:"));
        for (const file of existingFiles) {
          console.log(`  • ${file}`);
        }
        console.log();

        if (!options.yes) {
          const overwrite = await promptYesNo(
            "Overwrite existing files?",
            false,
          );
          if (!overwrite) {
            console.log();
            console.log("Aborted. To force overwrite, run:");
            console.log(`  ${chalk.cyan("vm0 setup-github --force")}`);
            process.exit(0);
          }
        }
        console.log();
      }

      // 5. Create workflow files (at git root)
      console.log("Creating workflow files...");
      await mkdir(path.join(gitRoot, ".github/workflows"), { recursive: true });

      await writeFile(publishPath, generatePublishYaml(workingDir));
      const publishStatus = existingFiles.includes(displayPublishPath)
        ? "Overwrote"
        : "Created";
      console.log(chalk.green(`✓ ${publishStatus} ${displayPublishPath}`));

      await writeFile(runPath, generateRunYaml(agentName, secrets, vars));
      const runStatus = existingFiles.includes(displayRunPath)
        ? "Overwrote"
        : "Created";
      console.log(chalk.green(`✓ ${runStatus} ${displayRunPath}`));
      console.log();

      // 6. Handle secrets/vars setup
      if (options.skipSecrets) {
        console.log(chalk.green("✓ Done (secrets setup skipped)"));
        return;
      }

      // Detect values
      const { secretStatuses, varStatuses } = await detectSecretValues(
        secrets,
        vars,
        vm0Token,
      );

      // Display status table
      displaySecretsTable(secretStatuses, varStatuses);
      console.log();

      // Check if any values were found
      const hasFoundValues =
        secretStatuses.some((s) => s.found) || varStatuses.some((v) => v.found);
      if (!hasFoundValues) {
        console.log("No secret/variable values found in environment.");
        console.log();
        showManualSetupInstructions(secrets, vars);
        console.log();
        showWorkflowsCreatedMessage();
        return;
      }

      // Prompt for auto-setup
      let shouldSetup = options.yes;
      if (!shouldSetup) {
        shouldSetup = await promptYesNo(
          "Set up GitHub secrets/variables automatically?",
          true,
        );
      }

      if (!shouldSetup) {
        console.log();
        showManualSetupInstructions(secrets, vars);
        console.log();
        showWorkflowsCreatedMessage();
        return;
      }

      // Set secrets
      console.log();
      console.log("Setting secrets...");
      const failedSecrets: string[] = [];
      for (const s of secretStatuses) {
        if (s.found && s.value) {
          const success = setGitHubSecret(s.name, s.value);
          if (success) {
            console.log(`  ${chalk.green("✓")} ${s.name}`);
          } else {
            console.log(`  ${chalk.red("✗")} ${s.name} (failed)`);
            failedSecrets.push(s.name);
          }
        } else {
          console.log(
            `  ${chalk.yellow("⚠")} ${s.name} (skipped - not found)`,
          );
        }
      }

      // Set variables
      const failedVars: string[] = [];
      if (varStatuses.length > 0) {
        console.log();
        console.log("Setting variables...");
        for (const v of varStatuses) {
          if (v.found && v.value) {
            const success = setGitHubVariable(v.name, v.value);
            if (success) {
              console.log(`  ${chalk.green("✓")} ${v.name}`);
            } else {
              console.log(`  ${chalk.red("✗")} ${v.name} (failed)`);
              failedVars.push(v.name);
            }
          } else {
            console.log(
              `  ${chalk.yellow("⚠")} ${v.name} (skipped - not found)`,
            );
          }
        }
      }

      // Final summary
      console.log();
      const missingSecrets = [
        ...secretStatuses.filter((s) => !s.found).map((s) => s.name),
        ...failedSecrets,
      ];
      const missingVars = [
        ...varStatuses.filter((v) => !v.found).map((v) => v.name),
        ...failedVars,
      ];

      if (missingSecrets.length === 0 && missingVars.length === 0) {
        showSuccessMessage();
      } else {
        showPartialSuccessMessage(missingSecrets, missingVars);
      }
    },
  );
