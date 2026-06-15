import { Command } from "commander";
import { createCommand } from "./create";
import { editCommand } from "./edit";
import { viewCommand } from "./view";
import { listCommand } from "./list";
import { deleteCommand } from "./delete";

export const zeroAgentCommand = new Command("agent")
  .description("View or manage zero agents")
  .addCommand(createCommand)
  .addCommand(editCommand)
  .addCommand(viewCommand)
  .addCommand(listCommand)
  .addCommand(deleteCommand)
  .addHelpText(
    "after",
    `
Examples:
  Your agent ID is in $ZERO_AGENT_ID (or run: zero whoami)
  View your config:      zero agent view $ZERO_AGENT_ID --instructions
  Update description:    zero agent edit $ZERO_AGENT_ID --description "new role"
  Update tone:           zero agent edit $ZERO_AGENT_ID --sound friendly
  Update instructions:   zero agent edit $ZERO_AGENT_ID --instructions-file <path>
  Add a custom skill:    zero agent edit $ZERO_AGENT_ID --add-skill my-skill
  Remove a skill:        zero agent edit $ZERO_AGENT_ID --remove-skill my-skill

Notes:
  Manage custom skills with 'zero skill --help'`,
  );
