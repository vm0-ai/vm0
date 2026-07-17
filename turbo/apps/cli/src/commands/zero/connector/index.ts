import { Command } from "commander";
import { checkConnectorCommand } from "./check";
import { connectCommand } from "./connect";
import { listCommand } from "./list";
import { searchCommand } from "./search";
import { statusCommand } from "./status";
import { customConnectorCommand } from "./custom";
import { permissionRequestCommand } from "./permission-request";

export const zeroConnectorCommand = new Command()
  .name("connector")
  .description("Manage and diagnose third-party service connections")
  .addCommand(checkConnectorCommand)
  .addCommand(customConnectorCommand)
  .addCommand(connectCommand)
  .addCommand(listCommand)
  .addCommand(searchCommand)
  .addCommand(statusCommand)
  .addCommand(permissionRequestCommand);
