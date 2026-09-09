import { Command } from "commander";
import { checkConnectorCommand } from "./check";
import { connectCommand } from "./connect";
import { listCommand } from "./list";
import { searchCommand } from "./search";
import { statusCommand } from "./status";
import { customConnectorCommand } from "./custom";
import { permissionRequestCommand } from "./permission-request";
import { connectorAccountCommand } from "./account";

export const connectorCommand = new Command()
  .name("connector")
  .description("Manage and diagnose third-party service connections")
  .addCommand(connectorAccountCommand)
  .addCommand(checkConnectorCommand)
  .addCommand(customConnectorCommand)
  .addCommand(connectCommand)
  .addCommand(listCommand)
  .addCommand(searchCommand)
  .addCommand(statusCommand)
  .addCommand(permissionRequestCommand)
  .addHelpText(
    "after",
    `
Choose a command:
  list/status   Inspect the current run's admitted accounts. Outside a run,
                list includes builtin and custom connectors; status is builtin-only.
  search        Discover builtin and custom HTTP/MCP connectors and connection guidance.
  custom        Create/update definitions and inspect org custom connector metadata.
  connect       Connect builtin connectors using manual grant values.
  check         Diagnose a failed URL or a builtin environment name.
  permission-request
                Request a diagnosed builtin permission; custom permissions use settings.

Connection and access:
  A definition describes the service and its authentication setup. Members then
  connect their own accounts, grant Agent access, and select any fine-grained
  permissions. Creating a custom definition alone does not complete these steps.
  OAuth and custom account connections use the web connection flow; search and
  custom create provide guidance for the next action.

Run context:
  Inside a run, omit --agent to use the current Agent (OKOU_AGENT_ID).
  An explicit --agent must match the current Agent.
  Agent selection does not replace the accounts admitted to that run. Missing
  run account context means unavailable; it does not select another account.
  Outside a run, commands exposing --agent can inspect that Agent's authorization.

Use each command's --help for its supported selectors and callback limits.`,
  );
