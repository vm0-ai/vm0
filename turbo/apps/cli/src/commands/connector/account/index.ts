import { Command } from "commander";

import { listConnectorAccountsCommand } from "./list";

export const connectorAccountCommand = new Command()
  .name("account")
  .description("Inspect connector accounts")
  .addCommand(listConnectorAccountsCommand);
