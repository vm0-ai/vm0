// VM0 CLI entry point - main module
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
import { logsCommand } from "./commands/logs";

import { initCommand } from "./commands/init";

import { upgradeCommand } from "./commands/upgrade";
import { whoamiCommand } from "./commands/whoami";

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
program.addCommand(logsCommand);

program.addCommand(initCommand);
program.addCommand(upgradeCommand);
program.addCommand(whoamiCommand);

export { program };

if (
  process.argv[1]?.endsWith("index.js") ||
  process.argv[1]?.endsWith("index.ts") ||
  process.argv[1]?.endsWith("vm0")
) {
  configureGlobalProxyFromEnv();
  program.parse();
}
