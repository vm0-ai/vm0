// VM0 CLI entry point
// Sentry must be initialized before any other imports
import "./instrument.js";
import { Command } from "commander";
import { authCommand } from "./commands/auth";
import { infoCommand } from "./commands/info";
import { composeCommand } from "./commands/compose";
import { runCommand } from "./commands/run";
import { volumeCommand } from "./commands/volume";
import { artifactCommand } from "./commands/artifact";
import { cookCommand } from "./commands/cook";
import { logsCommand } from "./commands/logs";
import { scopeCommand } from "./commands/scope";
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
import { devToolCommand } from "./commands/dev-tool";
import { preferenceCommand } from "./commands/preference";

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
program.addCommand(cookCommand);
program.addCommand(logsCommand);
program.addCommand(scopeCommand);
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
program.addCommand(devToolCommand, { hidden: true });

export { program };

if (
  process.argv[1]?.endsWith("index.js") ||
  process.argv[1]?.endsWith("index.ts") ||
  process.argv[1]?.endsWith("vm0")
) {
  program.parse();
}
// test comment Thu Feb  5 10:39:10 AM UTC 2026
// test comment Thu Feb 18 2026
