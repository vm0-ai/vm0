import { Command } from "commander";
import { startCommand } from "./host";
import { deleteCommand } from "./delete";
import { listCommand } from "./list";
import { runCommand } from "./run";

export const remoteAgentCommand = new Command()
  .name("remote-agent")
  .description("Run local Codex or Claude hosts for vm0")
  .addCommand(startCommand)
  .addCommand(listCommand)
  .addCommand(deleteCommand)
  .addCommand(runCommand);

export const zeroRemoteAgentCommand = new Command()
  .name("remote-agent")
  .description("Run jobs on remote-agent hosts")
  .addCommand(listCommand)
  .addCommand(runCommand);
