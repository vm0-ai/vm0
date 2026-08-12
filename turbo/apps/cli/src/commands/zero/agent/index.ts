import { Command } from "commander";
import { createCommand } from "./create";
import { editCommand } from "./edit";
import { viewCommand } from "./view";
import { listCommand } from "./list";
import { deleteCommand } from "./delete";

export const zeroAgentCommand = new Command("agent")
  .description("View or manage agents")
  .addCommand(createCommand)
  .addCommand(editCommand)
  .addCommand(viewCommand)
  .addCommand(listCommand)
  .addCommand(deleteCommand)
  .addHelpText(
    "after",
    `
Examples:
  Your agent ID is in $OKOU_AGENT_ID (or run: okou whoami)
  View your config:      okou agent view $OKOU_AGENT_ID --instructions
  Update description:    okou agent edit $OKOU_AGENT_ID --description "new role"
  Update tone:           okou agent edit $OKOU_AGENT_ID --sound friendly
  Update instructions:   okou agent edit $OKOU_AGENT_ID --instructions-file <path>
  Attach a workflow:     okou workflow attach <name> --agent $OKOU_AGENT_ID

Notes:
  Manage workflows with 'okou workflow --help'`,
  );
