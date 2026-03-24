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
import { cookCommand } from "./commands/cook";
import { logsCommand } from "./commands/logs";

import { initCommand } from "./commands/init";

import { preferenceCommand } from "./commands/preference";
import { upgradeCommand } from "./commands/upgrade";
import { whoamiCommand } from "./commands/whoami";
import { zeroCommand } from "./commands/zero";

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

program.addCommand(initCommand);
program.addCommand(preferenceCommand);
program.addCommand(upgradeCommand);
program.addCommand(whoamiCommand);
program.addCommand(zeroCommand);

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
