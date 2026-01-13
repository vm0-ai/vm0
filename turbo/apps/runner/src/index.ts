// VM0 Runner - Self-hosted runner for the VM0 platform
// Connects to the VM0 API server to poll and execute jobs in Firecracker microVMs
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
