import { Command } from "commander";

import { listConnectorAccountsCommand } from "./list";
import { switchConnectorAccountRequestCommand } from "./switch-request";

export const connectorAccountCommand = new Command()
  .name("account")
  .description("Inspect connector accounts")
  .addCommand(listConnectorAccountsCommand)
  .addCommand(switchConnectorAccountRequestCommand);
