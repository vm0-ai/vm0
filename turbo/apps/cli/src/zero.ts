// Zero CLI entry point - standalone binary for zero platform commands
// Sentry must be initialized before any other imports
import "./instrument.js";
import { Command } from "commander";
import { configureGlobalProxyFromEnv } from "./lib/network/proxy.js";
import { zeroOrgCommand } from "./commands/zero/org";
import { agentCommand } from "./commands/zero/agent";
import { zeroConnectorCommand } from "./commands/zero/connector";
import { zeroPreferenceCommand } from "./commands/zero/preference";
import { zeroScheduleCommand } from "./commands/zero/schedule";
import { zeroSecretCommand } from "./commands/zero/secret";
import { zeroSlackCommand } from "./commands/zero/slack";
import { zeroVariableCommand } from "./commands/zero/variable";
import { zeroWhoamiCommand } from "./commands/zero/whoami";

const program = new Command();

declare const __CLI_VERSION__: string;

program
  .name("zero")
  .description("Zero CLI - Manage your zero platform")
  .version(__CLI_VERSION__);

// Register all zero commands as top-level
program.addCommand(zeroOrgCommand);
program.addCommand(agentCommand);
program.addCommand(zeroConnectorCommand);
program.addCommand(zeroPreferenceCommand);
program.addCommand(zeroScheduleCommand);
program.addCommand(zeroSecretCommand);
program.addCommand(zeroSlackCommand);
program.addCommand(zeroVariableCommand);
program.addCommand(zeroWhoamiCommand);

export { program };

if (
  process.argv[1]?.endsWith("zero.js") ||
  process.argv[1]?.endsWith("zero.ts") ||
  process.argv[1]?.endsWith("zero")
) {
  // Handle EPIPE gracefully (e.g., `zero schedule list | head`)
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
