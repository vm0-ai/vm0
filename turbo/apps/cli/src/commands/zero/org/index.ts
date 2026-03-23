import { Command } from "commander";
import { statusCommand } from "./status";
import { setCommand } from "./set";
import { listCommand } from "./list";
import { useCommand } from "./use";
import { membersCommand } from "./members";
import { inviteCommand } from "./invite";
import { removeCommand } from "./remove";
import { leaveCommand } from "./leave";
import { deleteCommand } from "./delete";
import { zeroOrgSecretCommand } from "./secret";
import { zeroOrgVariableCommand } from "./variable";
import { zeroOrgModelProviderCommand } from "./model-provider";

export const zeroOrgCommand = new Command()
  .name("org")
  .description("Manage your organization")
  .addCommand(statusCommand)
  .addCommand(setCommand)
  .addCommand(listCommand)
  .addCommand(useCommand)
  .addCommand(membersCommand)
  .addCommand(inviteCommand)
  .addCommand(removeCommand)
  .addCommand(leaveCommand)
  .addCommand(deleteCommand)
  .addCommand(zeroOrgSecretCommand)
  .addCommand(zeroOrgVariableCommand)
  .addCommand(zeroOrgModelProviderCommand);
