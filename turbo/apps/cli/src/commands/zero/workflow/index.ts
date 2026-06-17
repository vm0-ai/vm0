import { Command } from "commander";
import { createCommand } from "./create";
import { editCommand } from "./edit";
import { viewCommand } from "./view";
import { listCommand } from "./list";
import { deleteCommand } from "./delete";
import { attachCommand } from "./attach";
import { detachCommand } from "./detach";
import { setAgentsCommand } from "./set-agents";

export const zeroWorkflowCommand = new Command("workflow")
  .description("Manage workflows")
  .addCommand(createCommand)
  .addCommand(editCommand)
  .addCommand(viewCommand)
  .addCommand(listCommand)
  .addCommand(deleteCommand)
  .addCommand(attachCommand)
  .addCommand(detachCommand)
  .addCommand(setAgentsCommand)
  .addHelpText(
    "after",
    `
Examples:
  Create from directory:   zero workflow create my-workflow --dir ./workflows/my-workflow/
  List workflows:          zero workflow list
  View workflow content:   zero workflow view my-workflow
  Update workflow content: zero workflow edit my-workflow --dir ./workflows/my-workflow/
  Delete a workflow:       zero workflow delete my-workflow -y

Agent Attachments:
  Attach to agent:         zero workflow attach my-workflow --agent <agent-id>
  Detach from agent:       zero workflow detach my-workflow --agent <agent-id>
  Replace all agents:      zero workflow set-agents my-workflow --agents a,b,c`,
  );
