import { Command } from "commander";
import { createCommand } from "./create";
import { statusCommand } from "./status";
import { inviteCommand } from "./invite";
import { removeCommand } from "./remove";
import { leaveCommand } from "./leave";

export const orgCommand = new Command()
  .name("org")
  .description("Manage organization scope")
  .addCommand(createCommand)
  .addCommand(statusCommand)
  .addCommand(inviteCommand)
  .addCommand(removeCommand)
  .addCommand(leaveCommand);
