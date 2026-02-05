import { Command } from "commander";
import { cloneCommand } from "./clone";
import { listCommand } from "./list";
import { statusCommand } from "./status";
import { publicCommand } from "./public";
import { privateCommand } from "./private";
import { shareCommand } from "./share";
import { unshareCommand } from "./unshare";
import { permissionsCommand } from "./permissions";

export const agentCommand = new Command()
  .name("agent")
  .description("Manage agent composes")
  .addCommand(cloneCommand)
  .addCommand(listCommand)
  .addCommand(statusCommand)
  .addCommand(publicCommand)
  .addCommand(privateCommand)
  .addCommand(shareCommand)
  .addCommand(unshareCommand)
  .addCommand(permissionsCommand);
