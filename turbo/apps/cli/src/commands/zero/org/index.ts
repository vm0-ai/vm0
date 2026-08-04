import { Command } from "commander";
import { statusCommand } from "./status";
import { listCommand } from "./list";
import { membersCommand } from "./members";
import { inviteCommand } from "./invite";
import { removeCommand } from "./remove";
import { leaveCommand } from "./leave";
import { zeroOrgSecretCommand } from "./secret";
import { zeroOrgVariableCommand } from "./variable";
import { zeroOrgModelProviderCommand } from "./model-provider";

export const zeroOrgCommand = new Command()
  .name("org")
  .description("Manage organization settings, members, and providers")
  .addCommand(statusCommand)
  .addCommand(listCommand)
  .addCommand(membersCommand)
  .addCommand(inviteCommand)
  .addCommand(removeCommand)
  .addCommand(leaveCommand)
  .addCommand(zeroOrgSecretCommand)
  .addCommand(zeroOrgVariableCommand)
  .addCommand(zeroOrgModelProviderCommand);
