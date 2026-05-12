import { Command } from "commander";
import { startCommand } from "./host";
import { deleteCommand } from "./delete";
import { listCommand } from "./list";
import { runCommand } from "./run";
import { runsCommand } from "./runs";

export const remoteAgentCommand = new Command()
  .name("remote-agent")
  .description("Run local Codex or Claude hosts for vm0")
  .addCommand(startCommand)
  .addCommand(listCommand)
  .addCommand(deleteCommand)
  .addCommand(runCommand)
  .addCommand(runsCommand);

export const zeroRemoteAgentCommand = new Command()
  .name("remote-agent")
  .description("Run jobs on remote-agent hosts")
  .addCommand(listCommand)
  .addCommand(runCommand)
  .addCommand(runsCommand);
