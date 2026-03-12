import { Command } from "commander";
import { statusCommand } from "./status";
import { setCommand } from "./set";
import { listCommand } from "./list";
import { useCommand } from "./use";
import { membersCommand } from "./members";
import { inviteCommand } from "./invite";
import { removeCommand } from "./remove";
import { leaveCommand } from "./leave";

export const orgCommand = new Command()
  .name("org")
  .description("Manage your organization (namespace for agents)")
  .addCommand(statusCommand)
  .addCommand(setCommand)
  .addCommand(listCommand)
  .addCommand(useCommand)
  .addCommand(membersCommand)
  .addCommand(inviteCommand)
  .addCommand(removeCommand)
  .addCommand(leaveCommand);
