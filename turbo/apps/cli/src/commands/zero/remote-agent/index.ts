import { Command } from "commander";
import { connectCommand } from "./connect";
import { hostStartCommand } from "./host";
import { runCommand } from "./run";

const hostCommand = new Command()
  .name("host")
  .description("Manage remote-agent host daemon")
  .addCommand(hostStartCommand);

export const zeroRemoteAgentCommand = new Command()
  .name("remote-agent")
  .description("Run local Codex or Claude hosts for zero")
  .addCommand(hostCommand)
  .addCommand(connectCommand)
  .addCommand(runCommand);
