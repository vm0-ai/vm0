// vm0-runner CLI entrypoint
import { program } from "commander";
import { startCommand } from "./commands/start.js";
import { statusCommand } from "./commands/status.js";

// Version is injected at build time by tsup
declare const __RUNNER_VERSION__: string;
const version =
  typeof __RUNNER_VERSION__ !== "undefined" ? __RUNNER_VERSION__ : "0.1.0";

program
  .name("vm0-runner")
  .version(version)
  .description("Self-hosted runner for VM0 agents");

program.addCommand(startCommand);
program.addCommand(statusCommand);

program.parse();
