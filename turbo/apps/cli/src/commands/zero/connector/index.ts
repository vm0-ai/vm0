import { Command } from "commander";
import { listCommand } from "./list";
import { searchCommand } from "./search";
import { statusCommand } from "./status";

export const zeroConnectorCommand = new Command()
  .name("connector")
  .description("Check third-party service connections (GitHub, Slack, etc.)")
  .addCommand(listCommand)
  .addCommand(searchCommand)
  .addCommand(statusCommand);
