import { Command } from "commander";
import { statusCommand } from "./status";
import { setCommand } from "./set";
import { listCommand } from "./list";
import { useCommand } from "./use";
import { createCommand } from "./create-scope";
import { membersCommand } from "./members";
import { inviteCommand } from "./invite";
import { removeCommand } from "./remove";
import { leaveCommand } from "./leave";

export const scopeCommand = new Command()
  .name("scope")
  .description("Manage your scope (namespace for agents)")
  .addCommand(statusCommand)
  .addCommand(setCommand)
  .addCommand(listCommand)
  .addCommand(useCommand)
  .addCommand(createCommand)
  .addCommand(membersCommand)
  .addCommand(inviteCommand)
  .addCommand(removeCommand)
  .addCommand(leaveCommand);
