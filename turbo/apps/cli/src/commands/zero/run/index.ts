import { mainRunCommand } from "./run";
import { continueCommand } from "./continue";

mainRunCommand.addCommand(continueCommand);

mainRunCommand.addHelpText(
  "after",
  `
Delegation workflow:
  Discover teammates:    zero agent list
  Delegate a task:       zero run <agent-id> "your task"
  Continue delegation:   zero run continue <session-id> "follow up"`,
);

export const zeroRunCommand = mainRunCommand;
