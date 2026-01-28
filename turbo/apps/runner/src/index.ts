// VM0 Runner - Self-hosted runner that polls the VM0 API server and executes agent jobs in isolated Firecracker microVMs
// Deployment: Added buildkit cache retry mechanism (issue #1328)
// CI: Refactored E2E tests with setup_file() - parallel tests use 45s timeout (issue #1555)
// Perf: Replaced Python vsock-agent with Rust for faster VM startup (issue #1668)
import { program } from "commander";
import { startCommand } from "./commands/start.js";
import { doctorCommand } from "./commands/doctor.js";
import { killCommand } from "./commands/kill.js";
import { benchmarkCommand } from "./commands/benchmark.js";

// Version is injected at build time by tsup
declare const __RUNNER_VERSION__: string;
const version =
  typeof __RUNNER_VERSION__ !== "undefined" ? __RUNNER_VERSION__ : "0.1.0";

program
  .name("vm0-runner")
  .version(version)
  .description("Self-hosted runner for VM0 agents");

program.addCommand(startCommand);
program.addCommand(doctorCommand);
program.addCommand(killCommand);
program.addCommand(benchmarkCommand);

program.parse();
