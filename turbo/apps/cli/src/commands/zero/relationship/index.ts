import { Command } from "commander";
import { getCommand } from "./get";
import { searchCommand } from "./search";

export const zeroRelationshipCommand = new Command()
  .name("relationship")
  .description("Query relationship memory")
  .addCommand(getCommand)
  .addCommand(searchCommand);
