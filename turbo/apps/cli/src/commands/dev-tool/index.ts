import { Command } from "commander";
import { composeCommand } from "./compose";

export const devToolCommand = new Command()
  .name("dev-tool")
  .description("Developer tools for testing and debugging")
  .addCommand(composeCommand);
