import { Command } from "commander";
import { setTierCommand } from "./set-tier";

export const devToolCommand = new Command()
  .name("dev-tool")
  .description("Developer tools for testing and debugging")
  .addCommand(setTierCommand);
