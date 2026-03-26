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
  .addCommand(deleteCommand);
