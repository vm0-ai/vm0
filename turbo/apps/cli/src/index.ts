// VM0 CLI entry point
// Sentry must be initialized before any other imports
import "./instrument.js";
import { Command } from "commander";
import { configureGlobalProxyFromEnv } from "./lib/network/proxy.js";
import { authCommand } from "./commands/auth";
import { infoCommand } from "./commands/info";
import { composeCommand } from "./commands/compose";
import { runCommand } from "./commands/run";
import { volumeCommand } from "./commands/volume";
import { artifactCommand } from "./commands/artifact";
import { memoryCommand } from "./commands/memory";
import { cookCommand } from "./commands/cook";
import { logsCommand } from "./commands/logs";
import chalk from "chalk";
import { orgCommand } from "./commands/org";
import { agentCommand } from "./commands/agent";
import { initCommand } from "./commands/init";
import { scheduleCommand } from "./commands/schedule";
import { usageCommand } from "./commands/usage";
import { secretCommand } from "./commands/secret";
import { variableCommand } from "./commands/variable";
import { modelProviderCommand } from "./commands/model-provider";
import { connectorCommand } from "./commands/connector";
import { onboardCommand } from "./commands/onboard";
import { setupClaudeCommand } from "./commands/setup-claude";
import { dashboardCommand } from "./commands/dashboard";
import { preferenceCommand } from "./commands/preference";
import { upgradeCommand } from "./commands/upgrade";

const program = new Command();

declare const __CLI_VERSION__: string;

program
  .name("vm0")
  .description("VM0 CLI - Build and run agents with natural language")
  .version(__CLI_VERSION__);

// Register all commands
program.addCommand(authCommand);
program.addCommand(infoCommand);
program.addCommand(composeCommand);
program.addCommand(runCommand);
program.addCommand(volumeCommand);
program.addCommand(artifactCommand);
program.addCommand(memoryCommand);
program.addCommand(cookCommand);
program.addCommand(logsCommand);
program.addCommand(orgCommand);

// Deprecated scope command alias — shows deprecation warning
const deprecatedScopeCommand = new Command("scope")
  .allowUnknownOption()
  .allowExcessArguments()
  .action((_options: unknown, command: Command) => {
    const args = command.args.join(" ");
    console.error(
      chalk.yellow(
        `⚠ 'vm0 scope' is deprecated. Use 'vm0 org${args ? " " + args : ""}' instead.`,
      ),
    );
    process.exit(1);
  });
program.addCommand(deprecatedScopeCommand, { hidden: true });
program.addCommand(agentCommand);
program.addCommand(initCommand);
program.addCommand(scheduleCommand);
program.addCommand(usageCommand);
program.addCommand(secretCommand);
program.addCommand(variableCommand);
program.addCommand(modelProviderCommand);
program.addCommand(connectorCommand);
program.addCommand(onboardCommand);
program.addCommand(setupClaudeCommand);
program.addCommand(dashboardCommand);
program.addCommand(preferenceCommand);
program.addCommand(upgradeCommand);

export { program };

if (
  process.argv[1]?.endsWith("index.js") ||
  process.argv[1]?.endsWith("index.ts") ||
  process.argv[1]?.endsWith("vm0")
) {
  // Handle EPIPE gracefully (e.g., `vm0 logs ... | head`)
  process.stdout.on("error", (err) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
  process.stderr.on("error", (err) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });

  configureGlobalProxyFromEnv();
  program.parse();
}
// test comment Thu Feb 18 2026 v2
// test comment Thu Feb 18 2026 v3
// test comment Thu Feb 18 2026 v4
// test comment Thu Feb 18 2026 v5
// test comment Thu Feb 18 2026 v6
// test comment Thu Feb 18 2026 v7
// test comment Thu Feb 18 2026 v8
// test comment Thu Feb 19 2026 v9
// test comment Thu Feb 19 2026 v10
// test comment Thu Feb 20 2026 v11
// test comment Sat Feb 22 2026 v12
